#!/usr/bin/env bun
import { defineCommand, effect, execute } from "cmdore"
import { assertIdea } from "./assert-idea"
import { renameTab, resolveTabPids } from "./core"

/**
 * Rename the WebStorm terminal tab THIS shell runs in — set a sticky
 * user-defined title that wins over shell/OSC auto-naming, or clear it to
 * restore auto-naming.
 *
 * The target tab is found by process id, not by name or position: `resolveTabPids`
 * lists the pids on our tty (login shell + any tmux client), and the Groovy
 * renames only the IDE terminal Content whose backend process is one of them.
 * Pids are globally unique, so exactly our tab is hit and no other project's tab
 * is touched. An empty pid set (not in a terminal, or a failed probe) renames
 * nothing.
 *
 * Reset (restore auto-naming) when `--reset` is passed, or when no non-empty
 * name is given (`rename-tab` / `rename-tab ""`). The real dispatch rides
 * `effect()` so `--dry-run` resolves pids but skips the IDE write; it is
 * best-effort and never throws (a missing IDE / spawn error degrades to a
 * stderr note inside runGroovyOn).
 *
 * @param name - the new tab title, or `null` to clear it (restore auto-naming).
 * @param verbose - echo the decision + resolved pids on stderr.
 * @returns nothing; the side effect is the renamed tab.
 *
 * @example
 * await renameTabCli("PR review") // sticky-rename this tab
 * await renameTabCli(null) // restore auto-naming
 */
export const renameTabCli = async (name: string | null, verbose = false): Promise<void> => {
    const pids = await resolveTabPids()
    if (verbose) {
        const what = name === null ? "reset (restore auto-naming)" : `name=${name}`
        process.stderr.write(`rename-tab: ${what}, pids=[${pids.join(",")}]\n`)
    }
    await effect(() => renameTab(name, pids))
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
        { name: "reset", arity: 0, description: "clear the tab title, restoring auto-naming" },
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
