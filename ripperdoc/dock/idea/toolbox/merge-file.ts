#!/usr/bin/env bun
/**
 * merge-file.ts — 3-way merge of two files (with an optional base) in the running
 * JetBrains IDE.
 *
 * The positionals are READ-ONLY inputs resolved strictly (a missing path throws
 * before launch). They map onto `idea merge`'s fixed arg order, OUTPUT LAST and
 * BASE (when present) THIRD: `merge <local> <remote> [<base>] <output>`. The
 * resolution lands in an internal output temp minted here, suffixed to mirror the
 * target's extension.
 *
 * Unlike diff, `idea merge` BLOCKS natively until Apply — there is no --wait flag.
 * So launch() is called with the default (async spawn, no --wait) and the process
 * is joined here via `await child.exited`.
 *
 * The CLI is a cmdore commandless command: cmdore owns parsing, help, the global
 * flags (--quiet/--verbose/--json/--dry-run/--help/--version), and exit codes.
 * main() wraps execute() with onError:"throw" so it can keep the repo CLI shape
 * (return a number; process.exit only under the import.meta.main guard) and map
 * IdeaError / a strict-resolve ENOENT / CmdoreError to the merge-file: stderr line.
 */

import { readFile, unlink } from "node:fs/promises"
import { extname } from "node:path"
import { CmdoreError, defineCommand, effect, execute } from "cmdore"
import { IdeaError } from "./core/errors.ts"
import { inIdea, launch as rawLaunch, reapLater } from "./core/index.ts"
import { mkstemp, resolveStrict } from "./tmp.ts"

const PROG = "merge-file"

/** cmdore metadata for the commandless CLI; version mirrors the idea plugin manifest. */
const METADATA = {
    name: PROG,
    version: "0.1.0",
    description: "3-way merge of two files (optional base) in the running JetBrains IDE."
} as const

/**
 * The write side-effect, wrapped as cmdore `effect.fn` so it is skipped on
 * `--dry-run` (when cmdore flips `effect.enabled` off) and mockable in tests by
 * the WRAPPER REFERENCE (`effect.mock(launch, …)`) — no per-file mutable seam.
 * The read-back is a READ and stays unwrapped (real `node:fs/promises`).
 */
export const launch = effect.fn(rawLaunch, "ide.launch")

/** Open a 3-way merge of `target`/`suggestion` (optional `base`) in the IDE. */
export const mergeFile = async (
    target: string,
    suggestion: string,
    base: string | null = null,
    wait = false
): Promise<string | null> => {
    const targetAbs = await resolveStrict(target)
    const suggestionAbs = await resolveStrict(suggestion)
    const baseAbs = base !== null ? await resolveStrict(base) : null

    // Internal output temp (not a caller arg). Mirror the target's extension for
    // syntax highlighting when it has one, else a plain default.
    const suffix = extname(targetAbs) || ".txt"
    const output = await mkstemp(suffix)

    // Fixed arg order: output LAST, base THIRD when present. No --wait — merge
    // blocks natively; spawn async and join the process below.
    const argv =
        baseAbs === null
            ? ["merge", targetAbs, suggestionAbs, output]
            : ["merge", targetAbs, suggestionAbs, baseAbs, output]
    const child = await launch(argv)

    if (!wait || child === undefined) {
        // Fire-and-forget (or dry-run skipped the launch): the IDE may still write
        // `output` after Apply; defer the reap.
        reapLater([output])
        return null
    }
    try {
        // merge blocks natively; joining the spawned process waits for Apply.
        await child.exited
        return await readFile(output, { encoding: "utf8" })
    } finally {
        await unlink(output)
    }
}

/**
 * The cmdore command behind the CLI. Gates on a live IDE, runs mergeFile, and on
 * the --wait path writes the merged output to stdout verbatim.
 */
const mergeFileCommand = defineCommand({
    name: PROG,
    description: METADATA.description,
    arguments: [
        { name: "target", description: "local / LEFT file", required: true },
        { name: "suggestion", description: "remote / RIGHT file", required: true },
        { name: "base", description: "optional common ancestor (BASE)" }
    ],
    options: [{ name: "wait", arity: 0, description: "join the native merge and print the merged output back" }],
    run: async ({ target, suggestion, base, wait }) => {
        if (!inIdea()) {
            throw new IdeaError("no JetBrains IDE in the process ancestry")
        }
        const result = await mergeFile(target, suggestion, base ?? null, wait)
        if (result !== null) {
            process.stdout.write(result)
        }
    }
})

/**
 * CLI entrypoint. Hands argv to cmdore (parsing, help, global flags), then maps
 * the domain failures to the merge-file: stderr line and their exit codes:
 * IdeaError -> 1, a strict-resolve ENOENT (Error with a string `.code`) -> 1,
 * CmdoreError (missing/unknown arg) -> its own exitCode. Else rethrow.
 */
export const main = async (argv: string[] = Bun.argv.slice(2)): Promise<number> => {
    try {
        await execute(mergeFileCommand, { argv, metadata: METADATA, onError: "throw" })
    } catch (error) {
        if (error instanceof CmdoreError) {
            process.stderr.write(`${PROG}: ${error.message}\n`)
            return error.exitCode
        }
        if (
            error instanceof IdeaError ||
            (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string")
        ) {
            process.stderr.write(`${PROG}: ${error.message}\n`)
            return 1
        }
        throw error
    }
    return 0
}

if (import.meta.main) {
    process.exit(await main())
}
