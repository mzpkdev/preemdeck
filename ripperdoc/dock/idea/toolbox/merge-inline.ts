#!/usr/bin/env bun
/**
 * merge-inline.ts — 3-way merge of inline strings (with an optional base) in the
 * running JetBrains IDE.
 *
 * A string-native wrapper over mergeFile: each version is spilled to a temp file
 * — `target`, `suggestion`, and `base` ONLY when not null — and handed to
 * mergeFile (which mints its own internal OUTPUT temp). wait=true: mergeFile
 * blocks until Apply and returns the result; unlink the input temps. wait=false:
 * mergeFile launched async; schedule a deferred reap for the input temps and
 * return null. The OUTPUT temp is mergeFile's to reap.
 *
 * The CLI is a cmdore commandless command: cmdore owns parsing, help, the global
 * flags (--quiet/--verbose/--json/--dry-run/--help/--version), and exit codes.
 * main() wraps execute() with onError:"throw" so it can keep the repo CLI shape
 * (return a number; process.exit only under the import.meta.main guard) and map
 * IdeaError / a strict-resolve ENOENT / CmdoreError to the merge-inline: stderr line.
 *
 * COMPOSITE: this delegates to merge-file's mergeFile() engine for real — only
 * the leaf launch() write is mocked in tests (reach-through, not stubbed). The
 * inputs spilled here are real temps, so mergeFile's strict resolve + read-back
 * exercise the genuine path.
 */

import { unlink } from "node:fs/promises"
import { CmdoreError, defineCommand, execute } from "cmdore"
import { IdeaError } from "./core/errors.ts"
import { inIdea, reapLater } from "./core/index.ts"
import { mergeFile } from "./merge-file.ts"
import { writeTemp } from "./tmp.ts"

const PROG = "merge-inline"

/** cmdore metadata for the commandless CLI; version mirrors the idea plugin manifest. */
const METADATA = {
    name: PROG,
    version: "0.1.0",
    description: "3-way merge of inline strings (optional base) in the running JetBrains IDE."
} as const

/** Options for {@link mergeInline}: the temp-file suffix (drives IDE syntax highlighting) and the wait toggle. */
export type MergeInlineOptions = {
    suffix?: string
    wait?: boolean
}

/** Merge inline strings by spilling each to a temp file, then delegating to mergeFile. */
export const mergeInline = async (
    target: string,
    suggestion: string,
    base: string | null = null,
    options: MergeInlineOptions = {}
): Promise<string | null> => {
    const suffix = options.suffix ?? ".txt"
    const wait = options.wait ?? false
    const temps: string[] = []
    try {
        const targetTmp = await writeTemp(target, suffix)
        temps.push(targetTmp)
        const suggestionTmp = await writeTemp(suggestion, suffix)
        temps.push(suggestionTmp)
        let baseTmp: string | null = null
        if (base !== null) {
            baseTmp = await writeTemp(base, suffix)
            temps.push(baseTmp)
        }
        const result = await mergeFile(targetTmp, suggestionTmp, baseTmp, wait)
        if (!wait) {
            // Fire-and-forget: the IDE still has the input temps open; defer the reap.
            // The output temp is mergeFile's to reap, so it's not in `temps`.
            reapLater(temps)
        }
        return result
    } finally {
        // wait=true: mergeFile already returned, input temps are spent — remove now.
        if (wait) {
            for (const path of temps) {
                await unlink(path)
            }
        }
    }
}

/**
 * The cmdore command behind the CLI. Gates on a live IDE, runs mergeInline, and
 * on the --wait path writes the merged output to stdout verbatim.
 */
const mergeInlineCommand = defineCommand({
    name: PROG,
    description: METADATA.description,
    arguments: [
        { name: "target", description: "local / LEFT text", required: true },
        { name: "suggestion", description: "remote / RIGHT text", required: true },
        { name: "base", description: "optional common ancestor (BASE) text" }
    ],
    options: [
        { name: "suffix", arity: 1, hint: "ext", description: "temp-file suffix (drives IDE syntax highlighting)" },
        { name: "wait", arity: 0, description: "block until Apply and print the merged output back" }
    ],
    run: async ({ target, suggestion, base, suffix, wait }) => {
        if (!inIdea()) {
            throw new IdeaError("no JetBrains IDE in the process ancestry")
        }
        const result = await mergeInline(target, suggestion, base ?? null, { suffix: suffix ?? ".txt", wait })
        if (result !== null) {
            process.stdout.write(result)
        }
    }
})

/**
 * CLI entrypoint. Hands argv to cmdore (parsing, help, global flags), then maps
 * the domain failures to the merge-inline: stderr line and their exit codes:
 * IdeaError -> 1, a strict-resolve ENOENT (Error with a string `.code`) -> 1,
 * CmdoreError (missing/unknown arg) -> its own exitCode. Else rethrow.
 */
export const main = async (argv: string[] = Bun.argv.slice(2)): Promise<number> => {
    try {
        await execute(mergeInlineCommand, { argv, metadata: METADATA, onError: "throw" })
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
