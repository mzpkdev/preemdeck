#!/usr/bin/env bun
import { defineCommand, effect, execute } from "cmdore"
import { assertIdea } from "./assert-idea"
import { isTabFocused, resolveTabTargets, type TabFocus, type TabTargets, UNDETERMINED } from "./core"

export type TabFocusedCliDeps = {
    resolveTabTargets: () => Promise<TabTargets>
    isTabFocused: (targets: TabTargets) => Promise<TabFocus>
}

const DEFAULT_DEPS: TabFocusedCliDeps = { resolveTabTargets, isTabFocused }

/**
 * Print whether the terminal tab THIS shell runs in is currently focused in the
 * IDE, and set the exit code as a scripting signal: 0 when focused, 1 when NOT
 * focused OR undetermined (fail-open). The JSON verdict + parts go to stdout so a
 * script can read them; `--verbose` echoes the parts on stderr.
 *
 * The real IDE read rides cmdore `effect()` so `--dry-run` SKIPS all IDE contact
 * and reports the fail-open {@link UNDETERMINED} reading (exit 1) — a pure read has
 * no destructive action to gate, so `--dry-run` here is the "don't touch the IDE"
 * mode the e2e spec drives. {@link isTabFocused} is itself best-effort and never
 * throws, so a live read still degrades to UNDETERMINED rather than failing.
 *
 * @param verbose - also echo the focus parts on stderr.
 * @returns the {@link TabFocus} reading (also printed as JSON to stdout).
 *
 * @example
 * // exit 0 + {"focused":true,...} when this tab is the focused one
 * tab-focused && notify "done"   // only notify when you're NOT looking here: use `|| notify`
 */
export const tabFocusedCli = async (verbose = false, deps: TabFocusedCliDeps = DEFAULT_DEPS): Promise<TabFocus> => {
    const targets = await deps.resolveTabTargets()
    // --dry-run disables effect(), so the IDE read is skipped and we report UNDETERMINED.
    // effect() is typed Promise<unknown>; it returns exactly isTabFocused's result live, else undefined.
    const result = ((await effect(() => deps.isTabFocused(targets))) as TabFocus | undefined) ?? UNDETERMINED
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (verbose) {
        process.stderr.write(
            `tab-focused: focused=${result.focused} tabSelected=${result.tabSelected} toolWindowActive=${result.toolWindowActive} frameFocused=${result.frameFocused}\n`
        )
    }
    return result
}

const command = defineCommand({
    name: "tab-focused",
    description: "Report whether the JetBrains terminal tab this shell runs in is focused (exit 0 focused, 1 not).",
    options: [{ name: "verbose", arity: 0, description: "report the focus parts on stderr" }],
    run: async ({ verbose }) => {
        assertIdea()
        const result = await tabFocusedCli(Boolean(verbose))
        // cmdore ignores run's return and only sets process.exitCode on THROW, so set the
        // scripting signal here: 0 focused, 1 not/undetermined. import.meta.main reads it.
        process.exitCode = result.focused ? 0 : 1
    }
})

if (import.meta.main) {
    // NOT process.exit(await execute(...)): execute returns 0 on success, which would clobber
    // the focused/not code set in run. Run execute (it still sets a nonzero code + prints on a
    // thrown assertIdea/parse error), then force-exit with the standing code — the force-exit
    // also skips runGroovyForResult's deferred reap timer (~3s) so the CLI doesn't hang.
    await execute(command, { metadata: command })
    process.exit(process.exitCode ?? 0)
}
