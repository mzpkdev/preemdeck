#!/usr/bin/env -S preemdeck-runtime
/**
 * tab-title.ts — rename the current JetBrains terminal TAB to reflect the agent's
 * state, so a glance across terminal tabs shows which session is idle, working, or
 * waiting on you. The IDE-side mirror of tmux-title.ts: it reuses that module's
 * glyph + name logic, so a tab reads `⚡ preemdeck` exactly like the tmux window
 * it mirrors.
 *
 * Wired on the host state events (see the three manifests): a prompt submit flips
 * the tab to ⚡, a turn end / session start back to 🤖, and a permission /
 * notification gate to 💬. On session end the user-defined title is cleared,
 * handing the tab name back to the IDE's auto-naming.
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
// window verbatim (e.g. `⚡ preemdeck`) — the glyph/name logic is NOT duplicated here.
import { GLYPH, projectLabel, windowName } from "../../tmux/toolbox/tmux-title"
import { inIdea, renameTab, resolveTabPids } from "./core"

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
    /** Resolve the pid set on this tab's tty (default: core resolveTabPids). */
    resolveTabPids: () => Promise<number[]>
    /** Rename the pid-matched tab(s) to `name`, or clear when null (default: {@link runRename}). */
    renameTab: (name: string | null, pids: readonly number[]) => Promise<void>
}

/**
 * The real IDE dispatch seam: rename this tab's terminal Content by pid, riding
 * cmdore effect() so --dry-run resolves pids but SKIPS the IDE write (mirrors
 * rename-tab.ts — core/tab.ts leaves the --dry-run gate to the caller). renameTab
 * is itself best-effort and never throws.
 */
export const runRename = async (name: string | null, pids: readonly number[]): Promise<void> => {
    await effect(() => renameTab(name, pids))
}

/** Production seam set: the real IDE gate, pid resolver, and effect()-gated rename. */
export const DEFAULT_DEPS: TabTitleDeps = { inIdea, resolveTabPids, renameTab: runRename }

/**
 * Apply the tab title for `state`. No-op (false) outside a JetBrains terminal, for
 * an unknown state, or when no pid resolves on this tab's tty; otherwise renames
 * the pid-matched tab(s) to windowName() (or clears it on reset) and returns true.
 * `deps` injects the IDE gate / pid / rename seams for hermetic tests.
 */
export const applyTitle = async (
    state: string,
    env: NodeJS.ProcessEnv = process.env,
    deps: TabTitleDeps = DEFAULT_DEPS
): Promise<boolean> => {
    if (!deps.inIdea()) {
        return false // not inside a JetBrains terminal — nothing to rename
    }
    const target = tabName(state, projectLabel(env))
    if (target === null) {
        return false // unknown state
    }
    const pids = await deps.resolveTabPids()
    if (pids.length === 0) {
        return false // no pid on this tab's tty — rename nothing rather than guess
    }
    await deps.renameTab(target.name, pids)
    return true
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
            await applyTitle(typeof state === "string" ? state : "")
        } catch {
            // swallow: no IDE, a foreign env, or a dispatch error must not disrupt the host
        }
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
