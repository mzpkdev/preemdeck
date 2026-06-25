#!/usr/bin/env bun
/**
 * in-idea.ts — report whether this terminal is running inside a JetBrains IDE.
 *
 * The same cheap gate every other tool applies before it acts: true when this
 * terminal was launched by a JetBrains IDE, false otherwise. The result is the
 * process exit code (0 inside, 1 outside) so it doubles as a shell gate; without
 * -q it also prints a human-readable line.
 *
 * A read/gate-only CLI: no write side-effects, so nothing is wrapped in
 * cmdore's `effect.fn`. cmdore owns parsing, help, the global flags, and
 * bad-flag exit codes; main() wraps execute() with onError:"throw" so it keeps
 * the repo CLI shape (return a number; process.exit only under the
 * import.meta.main guard).
 *
 * CAREFUL: -q here is NOT cmdore's global --quiet. cmdore's --quiet only
 * suppresses its own `terminal.*` output and never touches the exit code. This
 * CLI's -q must instead drive the EXIT-CODE contract (0 in-IDE, 1 outside, with
 * no human line). So it is defined as an explicit command option named `silent`
 * with alias `q`: passing -q sets ONLY this flag (cmdore's global `quiet` is a
 * different name, so it cannot hijack the gate), and the human line is gated on
 * it. The exit code is owned by main(): run() records the detection result on a
 * module-scoped seam (NOT thrown — "outside an IDE" is a valid result, not a
 * failure) and main() turns it into 0/1.
 */

import { CmdoreError, defineCommand, execute } from "cmdore"
import { NotImplementedError } from "./core/errors.ts"
import { inIdea } from "./core/index.ts"

const PROG = "in-idea"

/** cmdore metadata for the commandless CLI; version mirrors the idea plugin manifest. */
const METADATA = {
    name: PROG,
    version: "0.1.0",
    description: "Report whether this terminal is running inside a JetBrains IDE."
} as const

/**
 * Detection result handed from run() to main(). Defaults to `true` (exit 0) so
 * that if cmdore short-circuits before run() (e.g. --help / --version printed)
 * the CLI still exits successfully. run() overwrites it with the real result.
 */
let inside = true

/**
 * The cmdore command behind the CLI. Detects the IDE, records it for main() to
 * map to the exit code, and — unless -q (the explicit `silent` option) — prints
 * the human-readable line. NotImplementedError from the Linux stub propagates to
 * main() for its own mapping.
 */
const inIdeaCommand = defineCommand({
    name: PROG,
    description: METADATA.description,
    options: [{ name: "silent", alias: "q", arity: 0, description: "no output; gate on the exit code only" }],
    run: ({ silent }) => {
        inside = inIdea()
        if (!silent) {
            console.log(inside ? "in a JetBrains IDE terminal" : "not in a JetBrains IDE terminal")
        }
    }
})

/**
 * CLI entrypoint. Hands argv to cmdore (parsing, help, global flags), then
 * returns the shell-gate exit code: 0 inside a JetBrains IDE, 1 outside.
 * NotImplementedError (Linux stub) -> 1 with a read-logs-style note;
 * CmdoreError (bad flag) -> its own exitCode. Anything else is a bug and
 * rethrown.
 */
export const main = async (argv = Bun.argv.slice(2)): Promise<number> => {
    inside = true
    try {
        await execute(inIdeaCommand, { argv, metadata: METADATA, onError: "throw" })
    } catch (error) {
        if (error instanceof NotImplementedError) {
            process.stderr.write(`${PROG}: ${error.message}\n`)
            return 1
        }
        if (error instanceof CmdoreError) {
            process.stderr.write(`${PROG}: ${error.message}\n`)
            return error.exitCode
        }
        throw error
    }
    return inside ? 0 : 1
}

if (import.meta.main) {
    process.exit(await main())
}
