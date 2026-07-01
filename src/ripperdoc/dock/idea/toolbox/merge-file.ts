#!/usr/bin/env bun
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { defineCommand, effect, execute } from "cmdore"
import { assertIdea } from "./assert-idea"
import { focusProjectWindow, launch, reapLater } from "./core"
import { mkstemp, resolveStrict } from "./tmp"

/**
 * Open a 3-way merge of `target`/`suggestion` (optional common-ancestor `base`)
 * into an internal output temp in the running JetBrains IDE. The launch is wrapped
 * in `effect()` so `--dry-run` skips the real IDE call; on the `wait` path the
 * spawned merge process is joined to block until Apply, then the output is read back.
 *
 * @param target - local / LEFT file; resolved to an absolute path before launching.
 * @param suggestion - remote / RIGHT file; resolved to an absolute path before launching.
 * @param base - optional common ancestor (BASE); resolved when provided, else omitted.
 * @param wait - join the native merge and read the merged output back.
 * @returns the merged output's utf8 contents on the `wait` path, else null.
 *
 * @example
 * await mergeFile("local.ts", "remote.ts") // open the merge, fire-and-forget
 * const merged = await mergeFile("local.ts", "remote.ts", "base.ts", true) // block until Apply, then read the result
 */
export const mergeFile = async (
    target: string,
    suggestion: string,
    base: string | null = null,
    wait = false,
    cwd: string = process.cwd()
): Promise<string | null> => {
    const targetAbs = await resolveStrict(target)
    const suggestionAbs = await resolveStrict(suggestion)
    const baseAbs = base !== null ? await resolveStrict(base) : null

    // Internal output temp (not a caller arg). Mirror the target's extension for
    // syntax highlighting when it has one, else a plain default.
    const suffix = path.extname(targetAbs) || ".txt"
    const output = await mkstemp(suffix)

    // Fixed arg order: output LAST, base THIRD when present. No --wait — merge
    // blocks natively; spawn async and join the process below.
    const argv =
        baseAbs === null
            ? ["merge", targetAbs, suggestionAbs, output]
            : ["merge", targetAbs, suggestionAbs, baseAbs, output]
    // The CLI `merge` frame can't be window-targeted by flag, so focus the
    // terminal's window first (best-effort) and let the launcher attach there.
    await effect(() => focusProjectWindow(cwd))
    const child = (await effect(() => launch(argv))) as Awaited<ReturnType<typeof launch>> | undefined

    if (!wait || child === undefined) {
        // Fire-and-forget (or dry-run skipped the launch): the IDE may still write
        // `output` after Apply; defer the reap.
        reapLater([output])
        return null
    }
    try {
        // merge blocks natively; joining the spawned process waits for Apply.
        await child.exited
        return await fs.readFile(output, { encoding: "utf8" })
    } finally {
        await fs.unlink(output)
    }
}

const command = defineCommand({
    name: "merge-file",
    description: "3-way merge of two files (optional base) in the running JetBrains IDE.",
    arguments: [
        { name: "target", description: "local / LEFT file", required: true },
        { name: "suggestion", description: "remote / RIGHT file", required: true },
        { name: "base", description: "optional common ancestor (BASE)" }
    ],
    options: [
        {
            name: "wait",
            arity: 0,
            description: "join the native merge and print the merged output back"
        },
        { name: "verbose", arity: 0, description: "report diagnostic detail on stderr" }
    ],
    run: async ({ target, suggestion, base, wait, verbose }) => {
        assertIdea()
        if (verbose) {
            process.stderr.write(
                `merge-file: target=${target}, suggestion=${suggestion}, base=${base ?? "none"}, wait=${!!wait}\n`
            )
        }
        const result = await mergeFile(target, suggestion, base ?? null, wait)
        if (result !== null) {
            process.stdout.write(result)
        }
    }
})

if (import.meta.main) {
    const code = await execute(command, { metadata: command })
    if (code !== 0) {
        process.exit(code)
    }
}
