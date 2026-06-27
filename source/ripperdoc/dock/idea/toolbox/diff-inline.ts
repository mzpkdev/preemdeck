#!/usr/bin/env bun
import * as fs from "node:fs/promises"
import { defineCommand, execute } from "cmdore"
import { assertIdea } from "./assert-idea.ts"
import { reapLater } from "./core"
import { diffFile } from "./diff-file.ts"
import { writeTemp } from "./tmp.ts"

/** Options for {@link diffInline}: the temp-file suffix (drives IDE syntax highlighting) and the wait toggle. */
export type DiffInlineOptions = {
    suffix?: string
    wait?: boolean
}

/**
 * Diff the inline strings `target` vs `suggestion` by spilling each to a temp
 * file, then delegating to {@link diffFile}. On the `wait` path the input temps
 * are removed once the diff returns; otherwise the reap is deferred while the IDE
 * still holds them open.
 *
 * @param target - LEFT pane string; written to a temp file before diffing.
 * @param suggestion - RIGHT pane string; written to a temp file before diffing.
 * @param options - temp-file suffix and wait behavior; see {@link DiffInlineOptions}.
 * @returns the LEFT (`target`) pane's utf8 contents on the `wait` path, else null.
 *
 * @example
 * await diffInline(before, after, { suffix: ".ts" }) // show the diff, fire-and-forget
 * const left = await diffInline(before, after, { wait: true }) // block until closed, then read the LEFT pane
 */
export const diffInline = async (
    target: string,
    suggestion: string,
    options: DiffInlineOptions = {}
): Promise<string | null> => {
    const suffix = options.suffix ?? ".txt"
    const wait = options.wait ?? false
    const temps: string[] = []
    try {
        const targetTmp = await writeTemp(target, suffix)
        temps.push(targetTmp)
        const suggestionTmp = await writeTemp(suggestion, suffix)
        temps.push(suggestionTmp)
        const contents = await diffFile(targetTmp, suggestionTmp, wait)
        if (!wait) {
            // Fire-and-forget: the IDE still has both temps open; defer the reap.
            reapLater([targetTmp, suggestionTmp])
        }
        return contents
    } finally {
        // wait=true: diffFile already returned, temps are spent — remove now.
        if (wait) {
            for (const temp of temps) {
                await fs.unlink(temp)
            }
        }
    }
}

const command = defineCommand({
    name: "diff-inline",
    description: "Diff two inline strings in the running JetBrains IDE.",
    arguments: [
        { name: "target", description: "LEFT pane string", required: true },
        { name: "suggestion", description: "RIGHT pane string", required: true }
    ],
    options: [
        { name: "suffix", arity: 1, hint: "ext", description: "temp-file suffix (drives IDE syntax highlighting)" },
        {
            name: "wait",
            arity: 0,
            description: "block until the tab closes, then print the LEFT pane back"
        }
    ],
    run: async ({ target, suggestion, suffix, wait }) => {
        assertIdea()
        const contents = await diffInline(target, suggestion, { suffix, wait })
        if (contents !== null) {
            process.stdout.write(contents)
        }
    }
})

if (import.meta.main) {
    const code = await execute(command, { metadata: command })
    if (code !== 0) {
        process.exit(code)
    }
}
