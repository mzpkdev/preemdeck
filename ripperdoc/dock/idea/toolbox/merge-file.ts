#!/usr/bin/env bun
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { defineCommand, effect, execute } from "cmdore"
import { assertIdea } from "./assert-idea.ts"
import { launch, reapLater } from "./core"
import { boolean } from "./core/coercers.ts"
import { mkstemp, resolveStrict } from "./tmp.ts"

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
    const suffix = path.extname(targetAbs) || ".txt"
    const output = await mkstemp(suffix)

    // Fixed arg order: output LAST, base THIRD when present. No --wait — merge
    // blocks natively; spawn async and join the process below.
    const argv =
        baseAbs === null
            ? ["merge", targetAbs, suggestionAbs, output]
            : ["merge", targetAbs, suggestionAbs, baseAbs, output]
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
            description: "join the native merge and print the merged output back",
            coerce: boolean
        }
    ],
    run: async ({ target, suggestion, base, wait }) => {
        assertIdea()
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
