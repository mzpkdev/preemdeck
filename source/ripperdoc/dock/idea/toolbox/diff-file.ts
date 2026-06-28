#!/usr/bin/env bun
import * as fs from "node:fs/promises"
import { defineCommand, effect, execute } from "cmdore"
import { assertIdea } from "./assert-idea"
import { launch } from "./core"
import { resolveStrict } from "./tmp"

/**
 * Open a 2-way (`target` vs `suggestion`) diff in the running JetBrains IDE. The
 * launch is wrapped in `effect()` so `--dry-run` skips the real IDE call; the
 * `wait` read-back is a plain read of the LEFT (`target`) pane and stays unwrapped.
 *
 * @param target - LEFT pane file; resolved to an absolute path before launching.
 * @param suggestion - RIGHT pane file; resolved to an absolute path before launching.
 * @param wait - block until the tab closes, then read the LEFT pane back.
 * @returns the LEFT (`target`) pane's utf8 contents on the `wait` path, else null.
 *
 * @example
 * await diffFile("src/app.ts", "src/app.next.ts") // show the diff, fire-and-forget
 * const left = await diffFile("src/app.ts", "src/app.next.ts", true) // block until closed, then read the LEFT pane
 */
export const diffFile = async (target: string, suggestion: string, wait = false): Promise<string | null> => {
    const targetAbs = await resolveStrict(target)
    const suggestionAbs = await resolveStrict(suggestion)
    const args = ["diff", targetAbs, suggestionAbs]
    // 2-way always watches `target` (LEFT). launch() owns the native --wait.
    await effect(() => launch(args, { wait }))
    return wait ? await fs.readFile(targetAbs, { encoding: "utf8" }) : null
}

const command = defineCommand({
    name: "diff-file",
    description: "Diff two files in the running JetBrains IDE.",
    arguments: [
        { name: "target", description: "LEFT pane file", required: true },
        { name: "suggestion", description: "RIGHT pane file", required: true }
    ],
    options: [
        {
            name: "wait",
            arity: 0,
            description: "block until the tab closes, then print the LEFT pane back"
        }
    ],
    run: async ({ target, suggestion, wait }) => {
        assertIdea()
        const contents = await diffFile(target, suggestion, wait)
        if (contents !== null) {
            process.stdout.write(contents)
        }
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
