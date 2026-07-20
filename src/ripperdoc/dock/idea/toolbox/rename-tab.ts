#!/usr/bin/env bun
import { defineCommand, effect, execute } from "cmdore"
// The glyph + name composition, shared with tab-title / tmux-title so a model
// rename reads `• Name` exactly like the state hook's busy label.
import { windowName } from "../../tmux/toolbox/tmux-title"
import { assertIdea } from "./assert-idea"
import { renameTab, resolveTabTargets, type TabTargets } from "./core"

/**
 * Rename the WebStorm terminal tab THIS shell runs in — set a sticky
 * user-defined title that wins over shell/OSC auto-naming, or clear it to
 * restore auto-naming. The entry point for main-thread tab naming: the name is
 * tidied to short Title Case words and stamped with the busy glyph
 * (windowName("busy", name) -> "• Auth Retry") since a model rename always lands
 * during an active turn, so the tab matches tab-title's • instead of flashing
 * glyph-less. No on-disk store: the tab title itself is the source of truth, and
 * tab-title reads it back (glyph-stripped) so the name survives the
 * idle/busy/waiting flips. See {@link tidyTabName} / core/tab-read.ts.
 *
 * The target tab is found by process id, not by name or position: `resolveTabPids`
 * lists the pids on our tty (login shell + any tmux client), and the Groovy
 * renames only the IDE terminal Content whose backend process is one of them.
 * Pids are globally unique, so exactly our tab is hit and no other project's tab
 * is touched. An empty pid set (not in a terminal, or a failed probe) renames
 * nothing.
 *
 * Reset (restore auto-naming) when `--reset` is passed, or when no non-empty
 * name is given (`rename-tab` / `rename-tab ""`). The IDE dispatch rides
 * `effect()` so `--dry-run` resolves pids but skips the IDE write.
 *
 * @param name - the raw new tab title, or `null` to clear it (restore auto-naming).
 * @param verbose - echo the decision + resolved pids on stderr.
 * @param deps - injectable pid/rename seams for hermetic tests.
 * @returns nothing; the side effect is the renamed tab.
 *
 * @example
 * await renameTabCli("PR review") // rename this tab to "• PR Review"
 * await renameTabCli(null) // restore auto-naming
 */
export const renameTabCli = async (
    name: string | null,
    verbose = false,
    deps: RenameTabCliDeps = DEFAULT_DEPS
): Promise<void> => {
    // tidy is null iff name is null (tidyTabName always returns a string), so
    // branching on `tidy` below both reads as the reset check AND narrows it to string.
    const tidy = name === null ? null : tidyTabName(name)
    const targets = await deps.resolveTabTargets()
    if (verbose) {
        const what =
            tidy === null
                ? "reset (restore auto-naming)"
                : tidy.length > 0
                  ? `name=${tidy}`
                  : "no-op (name sanitized to empty)"
        process.stderr.write(
            `rename-tab: ${what}, pids=[${targets.pids.join(",")}], sessions=[${targets.termSessionIds.join(",")}]\n`
        )
    }
    if (tidy === null) {
        await deps.renameTab(null, targets) // clear the user-defined title, restoring auto-naming
        return
    }
    if (tidy.length === 0) {
        return // nothing usable in the given name — leave the tab as-is
    }
    // Stamp the busy glyph (a model rename always lands mid-turn) so the tab matches
    // tab-title's •. The name lives in the tab title itself (no on-disk store);
    // tab-title reads it back, glyph-stripped, to survive the next state flip.
    await deps.renameTab(windowName("busy", tidy), targets)
}

/**
 * Reduce a (model- or human-) chosen tab name to short Title Case words: take the
 * FIRST line, collapse every run of non-`[A-Za-z0-9]` (control chars, quotes, dashes,
 * punctuation) into a single space, trim, Title Case each word (an all-caps acronym
 * like PR / CI is kept as-is), and cap at 24 chars on a word boundary. Returns "" when
 * nothing usable remains (the caller treats "" as a no-op). Pure — no IDE or fs contact.
 */
export const tidyTabName = (raw: string): string => {
    const firstLine = raw.split("\n")[0] ?? ""
    const cleaned = firstLine.replace(/[^A-Za-z0-9]+/g, " ").trim()
    if (cleaned.length === 0) {
        return ""
    }
    const titled = cleaned
        .split(" ")
        .map((word) =>
            word.length > 1 && word === word.toUpperCase()
                ? word // keep an all-caps acronym (PR, CI, API) as-is
                : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
        )
        .join(" ")
    if (titled.length <= 24) {
        return titled
    }
    // Cap length on a word boundary so the tab never shows a half-word.
    const cut = titled.slice(0, 24)
    const lastSpace = cut.lastIndexOf(" ")
    return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim()
}

/** Injectable seams for {@link renameTabCli}; production uses the real pid resolver + IDE dispatch. */
export type RenameTabCliDeps = {
    /** Resolve the namespace-safe identity of this terminal tab. */
    resolveTabTargets: () => Promise<TabTargets>
    /** Rename the matched tab(s) to `name`, or clear when null (default: {@link runRename}). */
    renameTab: (name: string | null, targets: TabTargets) => Promise<void>
}

/**
 * The real IDE dispatch seam: rename this tab's terminal Content by pid, riding
 * cmdore effect() so --dry-run resolves pids but SKIPS the IDE write (mirrors
 * tab-title.ts). renameTab is itself best-effort and never throws.
 */
export const runRename = async (name: string | null, targets: TabTargets): Promise<void> => {
    await effect(() => renameTab(name, targets))
}

/** Production seam set: the real pid resolver and effect()-gated rename. */
export const DEFAULT_DEPS: RenameTabCliDeps = {
    resolveTabTargets,
    renameTab: runRename
}

const command = defineCommand({
    name: "rename-tab",
    description: "Rename the JetBrains terminal tab this shell runs in (best-effort).",
    arguments: [
        {
            name: "name",
            description: 'the new tab title (omit, pass "", or use --reset to restore auto-naming)'
        }
    ],
    options: [
        { name: "reset", arity: 0, description: "clear the tab title (and saved name), restoring auto-naming" },
        { name: "verbose", arity: 0, description: "report diagnostic detail on stderr" }
    ],
    run: async ({ name, reset, verbose }) => {
        assertIdea()
        // Reset when --reset is set or no non-empty name was given; else rename to it.
        const target: string | null = reset || !name || name.trim().length === 0 ? null : name
        await renameTabCli(target, Boolean(verbose))
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
