#!/usr/bin/env -S preemdeck-runtime
/**
 * tmux-title.ts — rename the current tmux window to reflect the agent's state, so a
 * glance across tmux windows shows which session is idle, working, or waiting on you.
 *
 * Wired on the host state events (see the three manifests): a prompt submit flips the
 * window to ◐, a turn end / session start back to ○, and a permission / notification
 * gate to ●. On session end the window's automatic-rename is restored, handing the
 * name back to tmux.
 *
 *     Claude  SessionStart→idle  UserPromptSubmit→busy  Notification→waiting  Stop→idle  SessionEnd→reset
 *     Codex   SessionStart→idle  UserPromptSubmit→busy  PermissionRequest→waiting  Stop→idle  (no SessionEnd/Notification)
 *     Gemini  SessionStart→idle  BeforeAgent→busy  Notification→waiting  AfterAgent→idle  SessionEnd→reset
 *
 * Inert outside tmux: with no $TMUX in the environment it exits 0 without spawning
 * anything, so it is a no-op for anyone not running the agent inside tmux. Best-effort
 * + SILENT by contract — it NEVER writes stdout (a SessionStart/UserPromptSubmit hook's
 * stdout is fed back to the model as context) and never exits nonzero, so the host
 * proceeds unchanged (an empty exit-0 leaves any permission flow untouched). Gated by
 * preemdeck.json notify.tmux (default on).
 *
 * The window is targeted by $TMUX_PANE (tmux sets it in every pane; a window command
 * resolves a pane target to its containing window), falling back to the active window
 * when it is absent. The spawn rides process.ts + cmdore's effect() so --dry-run
 * builds and reports the argv without renaming anything.
 */

import * as path from "node:path"
import { defineCommand, effect, execute } from "cmdore"
import { isNotifyEnabled } from "../../../../common/preemdeck"
import { PIPED, type Reaped, reap } from "../../../../common/process"

/**
 * The glyph that heads the window name for each non-reset state. Minimalist
 * monochrome circles by fill (empty idle, half busy, solid = needs you): single
 * cell and text-presentation, so they dodge the color-emoji width/render variance.
 */
export const GLYPH: Record<string, string> = {
    idle: "○",
    busy: "◐",
    waiting: "●"
}

/** The project label: the basename of the host's project dir / cwd, or "" when unknown. */
export const projectLabel = (env: NodeJS.ProcessEnv = process.env): string => {
    const dir = env.CLAUDE_PROJECT_DIR || env.GEMINI_PROJECT_DIR || env.PWD || ""
    return dir ? path.basename(dir) : ""
}

/** "<glyph> <project>", or the bare glyph when the project is unknown. */
export const windowName = (state: string, project: string): string => {
    const glyph = GLYPH[state] as string
    return project ? `${glyph} ${project}` : glyph
}

/**
 * The inverse of {@link windowName}: strip a leading state glyph (and the space
 * after it) off a composed title, returning the bare base name. A title with no
 * known glyph is returned trimmed unchanged (an IDE-menu rename or auto-name), and
 * a bare-glyph title (no project) strips to "". Used to recover the label base from
 * a tab's current title so a glyph flip re-prefixes instead of stacking glyphs.
 */
export const stripGlyph = (title: string): string => {
    const trimmed = title.trim()
    for (const glyph of Object.values(GLYPH)) {
        if (trimmed.startsWith(glyph)) {
            return trimmed.slice(glyph.length).trim()
        }
    }
    return trimmed
}

/**
 * The full tmux argv for `state`, or null when the state is unknown. `reset` restores
 * automatic-rename; every other known state renames the window to windowName(). The
 * window is targeted by `pane` ($TMUX_PANE) when present, else the active window.
 */
export const tmuxArgs = (state: string, project: string, pane: string | undefined): string[] | null => {
    const target = pane ? ["-t", pane] : []
    if (state === "reset") {
        return ["tmux", "set-window-option", ...target, "automatic-rename", "on"]
    }
    if (state in GLYPH) {
        return ["tmux", "rename-window", ...target, windowName(state, project)]
    }
    return null
}

/**
 * Run `cmd` to completion; resolve true iff it spawned and exited 0. A missing tmux
 * binary, non-zero exit, or timeout all resolve false. Never throws. Under --dry-run
 * the spawn is skipped (effect() → undefined) and treated as fired (true).
 */
export const runTmux = async (cmd: string[]): Promise<boolean> => {
    try {
        const result = (await effect(() => reap(Bun.spawn(cmd, PIPED), 5_000))) as Reaped | undefined
        if (result === undefined) return true
        return !result.timedOut && result.exitCode === 0
    } catch {
        return false
    }
}

/**
 * Apply the window title for `state`. No-op (false) outside tmux or for an unknown
 * state; otherwise builds the argv and runs it, returning whether it fired.
 */
export const applyTitle = async (
    state: string,
    env: NodeJS.ProcessEnv = process.env,
    run: (cmd: string[]) => Promise<boolean> = runTmux
): Promise<boolean> => {
    if (!env.TMUX) return false // not inside tmux — nothing to rename
    const cmd = tmuxArgs(state, projectLabel(env), env.TMUX_PANE)
    if (cmd === null) return false // unknown state
    return run(cmd)
}

const command = defineCommand({
    name: "tmux-title",
    description: "Rename the current tmux window to reflect the agent's state (idle/busy/waiting/reset).",
    arguments: [{ name: "state", description: "idle | busy | waiting | reset" }],
    run: async ({ state }) => {
        // Best-effort + SILENT: a title update must never fail or block the host hook,
        // so swallow everything and exit 0. NOTHING is written to stdout — a
        // SessionStart / UserPromptSubmit hook's stdout is fed back to the model.
        try {
            if (!(await isNotifyEnabled("tmux"))) {
                return // user disabled tmux titles via preemdeck.json notify.tmux
            }
            await applyTitle(typeof state === "string" ? state : "")
        } catch {
            // swallow: missing tmux, foreign env, or a spawn error must not disrupt the host
        }
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
