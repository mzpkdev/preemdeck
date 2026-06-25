#!/usr/bin/env bun
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { defineCommand, execute } from "cmdore"
import { assertIdea } from "./assert-idea.ts"
import { resolveLogDir } from "./core"
import { integer } from "./core/coercers.ts"

/**
 * Split `text` into lines on \r\n / \n / \r, dropping the trailing empty
 * segment after a final terminator (so "a\nb\n" -> ["a", "b"]).
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
 * Last `n` lines of the active IDE's idea.log. Read as latin1 so every byte
 * decodes without throwing.
 *
 * @param n - line count: n>0 -> last n; n==0 -> all; n<0 -> drop the first |n|.
 * @returns the selected log lines, terminators stripped.
 *
 * @example
 * const tail = await readLogs() // last 50 lines
 * const all = await readLogs(0) // the whole log
 */
export const readLogs = async (n = 50): Promise<string[]> => {
    const log = path.join(await resolveLogDir(), "idea.log")
    const lines = splitLines(await fs.readFile(log, { encoding: "latin1" }))
    return lines.slice(n > 0 ? Math.max(0, lines.length - n) : -n)
}

const command = defineCommand({
    name: "read-logs",
    description: "Read the last N lines of the running JetBrains IDE's log.",
    arguments: [{ name: "n", description: "number of lines to read (default 50)", coerce: integer }],
    run: async ({ n }) => {
        assertIdea()
        const lines = await readLogs(n ?? 50)
        console.log(lines.join("\n"))
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
