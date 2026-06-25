#!/usr/bin/env bun
/**
 * read-logs.ts — read the last N lines of the running JetBrains IDE's log.
 *
 * A read/gate-only CLI: no write side-effects, so nothing is wrapped in
 * cmdore's `effect.fn`. It gates on a live IDE (core `inIdea()`, which honors
 * the `PREEMDECK_FORCE_IN_IDEA` env override), resolves the log dir, and reads
 * idea.log off the real FS.
 *
 * cmdore owns parsing, help, the global flags (--quiet/--verbose/--json/
 * --dry-run/--help/--version), and bad-flag exit codes. main() wraps execute()
 * with onError:"throw" so it keeps the repo CLI shape (return a number;
 * process.exit only under the import.meta.main guard) and maps the domain
 * failures (IdeaError, an FS errno error, CmdoreError) to the read-logs:
 * prefixed stderr line.
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { StandardSchemaV1 } from "cmdore"
import { CmdoreError, defineCommand, execute } from "cmdore"
import { IdeaError } from "./core/errors.ts"
import { inIdea, resolveLogDir } from "./core/index.ts"

const PROG = "read-logs"

/** cmdore metadata for the commandless CLI; version mirrors the idea plugin manifest. */
const METADATA = {
    name: PROG,
    version: "0.1.0",
    description: "Read the last N lines of the running JetBrains IDE's log."
} as const

/**
 * A Standard Schema that coerces the `n` token to an integer. cmdore hands it
 * the raw string; a non-integer fails validation, which cmdore surfaces as a
 * CmdoreError carrying this message.
 */
const integer = (name: string): StandardSchemaV1<number> => ({
    "~standard": {
        version: 1,
        vendor: "preemdeck",
        validate: (value: unknown) => {
            const text = String(value).trim()
            return /^[+-]?\d+$/.test(text)
                ? { value: Number.parseInt(text, 10) }
                : { issues: [{ message: `${name} must be an integer, got '${value}'` }] }
        }
    }
})

/**
 * Split `text` into lines on \r\n / \n / \r, dropping the trailing empty
 * segment after a final terminator (so "a\nb\n" -> ["a", "b"]). Other Unicode
 * line boundaries are vanishingly rare in idea.log and out of scope.
 */
const splitLines = (text: string): string[] => {
    if (text === "") {
        return []
    }
    const lines = text.split(/\r\n|\r|\n/)
    if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop()
    }
    return lines
}

/**
 * Last `n` lines of the active IDE's idea.log.
 *
 * resolveLogDir() is the single guard for a live IDE: it throws IdeaError if
 * none is found. The file is read as latin1 so every byte decodes without
 * throwing (errors="replace" parity for the tail use case). Slice semantics:
 * n>0 -> last n; n==0 -> all; n<0 -> drop the first |n|.
 */
export const readLogs = async (n = 50): Promise<string[]> => {
    const log = join(await resolveLogDir(), "idea.log")
    const lines = splitLines(await readFile(log, { encoding: "latin1" }))
    return lines.slice(n > 0 ? Math.max(0, lines.length - n) : -n)
}

/**
 * The cmdore command behind the CLI. Gates on a live IDE (cheap fail-fast
 * before resolveLogDir()'s deeper resolveExecPath() ancestry walk; reuse the
 * IdeaError path so the message matches the resolver-triggered failure), runs
 * readLogs, and writes the joined lines to stdout.
 */
const readLogsCommand = defineCommand({
    name: PROG,
    description: METADATA.description,
    arguments: [{ name: "n", description: "number of lines to read (default 50)", schema: integer("n") }],
    run: async ({ n }) => {
        if (!inIdea()) {
            throw new IdeaError("no JetBrains IDE in the process ancestry")
        }
        const lines = await readLogs(n ?? 50)
        console.log(lines.join("\n"))
    }
})

/**
 * CLI entrypoint. Hands argv to cmdore (parsing, help, global flags), then maps
 * the domain failures to the read-logs: stderr line and their exit codes:
 * IdeaError -> 1, an FS errno error (e.g. idea.log missing) -> 1, CmdoreError
 * (bad flag / non-integer n) -> its own exitCode. Anything else is a bug and
 * rethrown.
 */
export const main = async (argv = Bun.argv.slice(2)): Promise<number> => {
    try {
        await execute(readLogsCommand, { argv, metadata: METADATA, onError: "throw" })
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
