#!/usr/bin/env bun
import * as fs from "node:fs/promises"
import { defineCommand, execute } from "cmdore"
import { assertIdea } from "./assert-idea.ts"
import { reapLater } from "./core"
import { boolean } from "./core/coercers.ts"
import { mergeFile } from "./merge-file.ts"
import { writeTemp } from "./tmp.ts"

/** Options for {@link mergeInline}: the temp-file suffix (drives IDE syntax highlighting) and the wait toggle. */
export type MergeInlineOptions = {
    suffix?: string
    wait?: boolean
}

/**
 * Merge the inline strings `target`/`suggestion` (optional common-ancestor `base`)
 * by spilling each to a temp file, then delegating to {@link mergeFile}. On the
 * `wait` path the input temps are removed once the merge returns; otherwise the
 * reap is deferred while the IDE still holds them open (the output temp is mergeFile's to reap).
 *
 * @param target - local / LEFT text; written to a temp file before merging.
 * @param suggestion - remote / RIGHT text; written to a temp file before merging.
 * @param base - optional common ancestor (BASE) text; written to a temp file when provided.
 * @param options - temp-file suffix and wait behavior; see {@link MergeInlineOptions}.
 * @returns the merged output's utf8 contents on the `wait` path, else null.
 *
 * @example
 * await mergeInline(local, remote) // open the merge, fire-and-forget
 * const merged = await mergeInline(local, remote, base, { wait: true }) // block until Apply, then read the result
 */
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
            for (const temp of temps) {
                await fs.unlink(temp)
            }
        }
    }
}

const command = defineCommand({
    name: "merge-inline",
    description: "3-way merge of inline strings (optional base) in the running JetBrains IDE.",
    arguments: [
        { name: "target", description: "local / LEFT text", required: true },
        { name: "suggestion", description: "remote / RIGHT text", required: true },
        { name: "base", description: "optional common ancestor (BASE) text" }
    ],
    options: [
        { name: "suffix", arity: 1, hint: "ext", description: "temp-file suffix (drives IDE syntax highlighting)" },
        {
            name: "wait",
            arity: 0,
            description: "block until Apply and print the merged output back",
            coerce: boolean
        }
    ],
    run: async ({ target, suggestion, base, suffix, wait }) => {
        assertIdea()
        const result = await mergeInline(target, suggestion, base ?? null, { suffix: suffix ?? ".txt", wait })
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
