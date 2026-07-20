#!/usr/bin/env -S preemdeck-runtime
/**
 * tab-title.ts — rename the current JetBrains terminal TAB to reflect the agent's
 * state, so a glance across terminal tabs shows which session is idle, working, or
 * waiting on you. The IDE-side mirror of tmux-title.ts: it reuses that module's
 * glyph + name logic, so a tab reads `• preemdeck` exactly like the tmux window
 * it mirrors.
 *
 * Wired on the host state events (see the three manifests): a prompt submit flips
 * the tab to •, a turn end / session start back to ◦, and a permission /
 * notification gate to ⊙. On session end the user-defined title is cleared,
 * handing the tab name back to the IDE's auto-naming.
 *
 * The Notification event is overloaded: besides a permission gate it also fires
 * Claude's idle "waiting for your input" ping (~60s after a turn ends), which lands
 * AFTER Stop's ◦ and would strand an idle tab on ⊙. effectiveState reads the
 * payload and downgrades that ping back to idle, so only a real gate shows ⊙.
 *
 *     Claude  SessionStart→idle  UserPromptSubmit→busy  Notification→waiting  Stop→idle  SessionEnd→reset
 *     Codex   SessionStart→idle  UserPromptSubmit→busy  PermissionRequest→waiting  Stop→idle  (no SessionEnd/Notification)
 *     Gemini  SessionStart→idle  BeforeAgent→busy  Notification→waiting  AfterAgent→idle  SessionEnd→reset
 *
 * Inert outside a JetBrains terminal: when inIdea() is false it exits 0 without
 * touching anything, so it is a no-op for anyone not running the agent inside a
 * JetBrains IDE. It is also a no-op when no pid resolves on this tab's tty
 * (resolveTabPids() empty) — it renames nothing rather than guessing. Best-effort
 * + SILENT by contract — it NEVER writes stdout (a SessionStart/UserPromptSubmit
 * hook's stdout is fed back to the model as context) and never exits nonzero, so
 * the host proceeds unchanged. Gated by preemdeck.json notify.ideaTab (default on).
 *
 * The tab is targeted by process id, not name/position: resolveTabPids() lists the
 * pids on this shell's tty (login shell + any tmux client), and renameTab renames
 * only the IDE terminal Content whose backend process pid is one of them. Pids are
 * globally unique, so exactly this tab is hit and no other project's tab is touched
 * (see core/tab.ts). The dispatch rides cmdore effect() so --dry-run resolves pids
 * but skips the IDE write.
 */

import { defineCommand, effect, execute } from "cmdore"
import { isNotifyEnabled } from "../../../../common/preemdeck"
// Reuse the glyph + name logic from tmux-title so the tab label matches the tmux
// window verbatim (e.g. `• preemdeck`) — the glyph/name logic is NOT duplicated here.
import { GLYPH, projectLabel, stripGlyph, windowName } from "../../tmux/toolbox/tmux-title"
import { inIdea, readTabTitle, renameTab, resolveTabTargets, type TabTargets } from "./core"
// The Notification event is overloaded: it fires for real permission gates AND for
// Claude's idle "waiting for your input" ping. isIdleNotification tells them apart
// (shared with permission-notify); readHookInput is the fail-safe stdin parser.
import { isIdleNotification } from "./permission-notify"
import { readHookInput } from "./turn-notify"

/**
 * The rename target for `state`, or null when the state is unknown (the caller
 * no-ops). `reset` clears the user-defined title (`{ name: null }`, restoring the
 * IDE's auto-naming); every other known state renames the tab to windowName().
 * Pure — mirrors tmux-title's tmuxArgs builder; no IDE contact. A wrapper object
 * carries the name so a `reset`'s `null` (clear) is distinct from `null` (unknown
 * state → no-op).
 */
export const tabName = (state: string, project: string): { name: string | null } | null => {
    if (state === "reset") {
        return { name: null }
    }
    if (state in GLYPH) {
        return { name: windowName(state, project) }
    }
    return null
}

/** Injectable seams for {@link applyTitle}; production uses the real IDE gate + pid-matched rename. */
export type TabTitleDeps = {
    /** True when this terminal was launched by a JetBrains IDE (default: core inIdea). */
    inIdea: () => boolean
    /** Resolve the namespace-safe identity of this terminal tab. */
    resolveTabTargets: () => Promise<TabTargets>
    /** Rename the matched tab(s) to `name`, or clear when null (default: {@link runRename}). */
    renameTab: (name: string | null, targets: TabTargets) => Promise<void>
    /** Read the matched tab's current displayed title, or null (default: core readTabTitle). */
    readTabTitle: (targets: TabTargets) => Promise<string | null>
}

/**
 * The real IDE dispatch seam: rename this tab's terminal Content by pid, riding
 * cmdore effect() so --dry-run resolves pids but SKIPS the IDE write (mirrors
 * rename-tab.ts — core/tab.ts leaves the --dry-run gate to the caller). renameTab
 * is itself best-effort and never throws.
 */
export const runRename = async (name: string | null, targets: TabTargets): Promise<void> => {
    await effect(() => renameTab(name, targets))
}

/** Production seam set: the real IDE gate, pid resolver, effect()-gated rename, and title read-back. */
export const DEFAULT_DEPS: TabTitleDeps = {
    inIdea,
    resolveTabTargets,
    renameTab: runRename,
    readTabTitle
}

/**
 * Apply the tab title for `state`. No-op (false) outside a JetBrains terminal, for
 * an unknown state, or when no pid resolves on this tab's tty; otherwise renames
 * the pid-matched tab(s) to windowName() (or clears it on reset) and returns true.
 * `deps` injects the IDE gate / pid / rename / title-read seams for hermetic tests.
 *
 * The label BASE is the tab's OWN current title read back from the IDE
 * (readTabTitle), glyph-stripped, else the project label — so a glyph flip (idle/
 * busy/waiting) preserves a name set by rename-tab OR from the IDE's own tab menu
 * (`• tab-naming` -> `◦ tab-naming`) instead of reverting to the bare project. No
 * on-disk store: the tab itself is the source of truth. The `reset` state clears
 * the user-defined title, restoring the IDE's auto-naming.
 */
export const applyTitle = async (
    state: string,
    env: NodeJS.ProcessEnv = process.env,
    deps: TabTitleDeps = DEFAULT_DEPS
): Promise<boolean> => {
    if (!deps.inIdea()) {
        return false // not inside a JetBrains terminal — nothing to rename
    }
    const targets = await deps.resolveTabTargets()
    if (targets.pids.length === 0 && targets.termSessionIds.length === 0) {
        return false // no exact identity for this tab — rename nothing rather than guess
    }
    // Recover the base from the tab's current title (glyph-stripped) so a rename-tab
    // or IDE-menu name survives the flip; fall back to the project label. Only a glyph
    // state reads the title — reset just clears, an unknown state no-ops.
    const base = state in GLYPH ? stripGlyph((await deps.readTabTitle(targets)) ?? "") || projectLabel(env) : ""
    const target = tabName(state, base)
    if (target === null) {
        return false // unknown state
    }
    await deps.renameTab(target.name, targets)
    return true
}

/**
 * The state to actually apply for the manifest-passed `state`. Only "waiting" is
 * conditional: the Notification event that carries it ALSO fires Claude's idle
 * "waiting for your input" ping, which means the tab is IDLE, not gated — so read
 * the payload and downgrade that ping to "idle" (else an idle tab sticks on ⊙).
 * Every other state passes through untouched and never reads stdin. A real
 * permission gate (isIdleNotification false) stays "waiting".
 *
 * `read` is the injectable payload seam (default {@link readHookInput}, which is
 * fail-safe: a TTY / empty / malformed stdin reads as `{}`) for hermetic tests.
 */
export const effectiveState = async (
    state: string,
    read: () => Promise<Record<string, unknown>> = readHookInput
): Promise<string> => {
    if (state !== "waiting") {
        return state
    }
    return isIdleNotification(await read()) ? "idle" : "waiting"
}

const command = defineCommand({
    name: "tab-title",
    description: "Rename the current JetBrains terminal tab to reflect the agent's state (idle/busy/waiting/reset).",
    arguments: [{ name: "state", description: "idle | busy | waiting | reset" }],
    run: async ({ state }) => {
        // Best-effort + SILENT: a title update must never fail or block the host
        // hook, so swallow everything and exit 0. NOTHING is written to stdout — a
        // SessionStart / UserPromptSubmit hook's stdout is fed back to the model.
        try {
            if (!(await isNotifyEnabled("ideaTab"))) {
                return // user disabled WebStorm tab titles via preemdeck.json notify.ideaTab
            }
            const selected = await effectiveState(typeof state === "string" ? state : "")
            await effect(() => applyTitle(selected))
        } catch {
            // swallow: no IDE, a foreign env, or a dispatch error must not disrupt the host
        }
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
