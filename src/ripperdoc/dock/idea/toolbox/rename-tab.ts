#!/usr/bin/env bun
import { defineCommand, effect, execute } from "cmdore"
// The glyph + name composition, shared with tab-title / tmux-title so a model
// rename reads `◐ slug` exactly like the state hook's busy label.
import { windowName } from "../../tmux/toolbox/tmux-title"
import { assertIdea } from "./assert-idea"
import { renameTab, resolveTabPids } from "./core"

/**
 * Rename the WebStorm terminal tab THIS shell runs in — set a sticky
 * user-defined title that wins over shell/OSC auto-naming, or clear it to
 * restore auto-naming. The entry point for main-thread tab naming: the name is
 * sanitized to a short slug and stamped with the busy glyph (windowName("busy",
 * slug) -> "◐ slug") since a model rename always lands during an active turn, so
 * the tab matches tab-title's ◐ instead of flashing glyph-less. No on-disk store:
 * the tab title itself is the source of truth, and tab-title reads it back
 * (glyph-stripped) so the name survives the idle/busy/waiting flips. See
 * {@link slugifyTabName} / core/tab-read.ts.
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
 * await renameTabCli("PR review") // rename this tab to "◐ pr-review"
 * await renameTabCli(null) // restore auto-naming
 */
export const renameTabCli = async (
    name: string | null,
    verbose = false,
    deps: RenameTabCliDeps = DEFAULT_DEPS
): Promise<void> => {
    // slug is null iff name is null (slugifyTabName always returns a string), so
    // branching on `slug` below both reads as the reset check AND narrows it to string.
    const slug = name === null ? null : slugifyTabName(name)
    const pids = await deps.resolveTabPids()
    if (verbose) {
        const what =
            slug === null
                ? "reset (restore auto-naming)"
                : slug.length > 0
                  ? `name=${slug}`
                  : "no-op (name sanitized to empty)"
        process.stderr.write(`rename-tab: ${what}, pids=[${pids.join(",")}]\n`)
    }
    if (slug === null) {
        await deps.renameTab(null, pids) // clear the user-defined title, restoring auto-naming
        return
    }
    if (slug.length === 0) {
        return // nothing usable in the given name — leave the tab as-is
    }
    // Stamp the busy glyph (a model rename always lands mid-turn) so the tab matches
    // tab-title's ◐. The name lives in the tab title itself (no on-disk store);
    // tab-title reads it back, glyph-stripped, to survive the next state flip.
    await deps.renameTab(windowName("busy", slug), pids)
}

/**
 * Reduce a (model- or human-) chosen tab name to a safe, short slug: take the
 * FIRST line, strip control chars, trim, drop any surrounding quotes/backticks,
 * lowercase, collapse every run of non-`[a-z0-9]` into a single hyphen, trim edge
 * hyphens, and cap at 24 chars. Returns "" when nothing usable remains (the caller
 * treats "" as a no-op). Pure — no IDE or fs contact.
 */
export const slugifyTabName = (raw: string): string => {
    const firstLine = raw.split("\n")[0] ?? ""
    return (
        firstLine
            // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping C0/DEL control chars from a tab title
            .replace(/[\u0000-\u001f\u007f]/g, "") // strip control chars
            .trim()
            .replace(/^['"`]+|['"`]+$/g, "") // strip surrounding quotes / backticks
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-") // non-alphanumeric runs -> single hyphen
            .replace(/^-+|-+$/g, "") // trim leading / trailing hyphens
            .slice(0, 24) // cap length
            .replace(/-+$/g, "")
    ) // re-trim a hyphen the slice may have exposed
}

/** Injectable seams for {@link renameTabCli}; production uses the real pid resolver + IDE dispatch. */
export type RenameTabCliDeps = {
    /** Resolve the pid set on this tab's tty (default: core `resolveTabPids`). */
    resolveTabPids: () => Promise<number[]>
    /** Rename the pid-matched tab(s) to `name`, or clear when null (default: {@link runRename}). */
    renameTab: (name: string | null, pids: readonly number[]) => Promise<void>
}

/**
 * The real IDE dispatch seam: rename this tab's terminal Content by pid, riding
 * cmdore effect() so --dry-run resolves pids but SKIPS the IDE write (mirrors
 * tab-title.ts). renameTab is itself best-effort and never throws.
 */
export const runRename = async (name: string | null, pids: readonly number[]): Promise<void> => {
    await effect(() => renameTab(name, pids))
}

/** Production seam set: the real pid resolver and effect()-gated rename. */
export const DEFAULT_DEPS: RenameTabCliDeps = {
    resolveTabPids,
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
