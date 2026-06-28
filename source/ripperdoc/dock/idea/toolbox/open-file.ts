#!/usr/bin/env bun
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { defineCommand, effect, execute } from "cmdore"
import { assertIdea } from "./assert-idea"
import { launch, setPreview } from "./core"
import { integer } from "./core/coercers"

export type OpenOptions = {
    line?: number
    column?: number | null
    wait?: boolean
    preview?: boolean
    /** Working directory used to target the terminal's window on the preview flip (longest basePath prefix). Defaults to `process.cwd()`. */
    cwd?: string
    /** Injectable core ops for hermetic tests (default: the real `launch`/`setPreview`). Lets a test drive the launch/preview ordering without a real IDE. */
    deps?: {
        launch?: typeof launch
        setPreview?: typeof setPreview
    }
}

/**
 * Open `file` in the running JetBrains IDE at an optional caret position. The
 * launch is wrapped in `effect()` so `--dry-run` skips the real IDE call; the
 * `--wait` read-back is a plain read and stays unwrapped.
 *
 * @param file - path to open; resolved to an absolute path before launching.
 * @param options - caret position and wait/preview behavior; see {@link OpenOptions}.
 * @returns the file's utf8 contents on the `wait` path, else null.
 *
 * @example
 * await openFile("src/app.ts", { line: 42 }) // jump to the line, fire-and-forget
 * const text = await openFile("notes.md", { wait: true }) // block until closed, then read back
 * const edited = await openFile("plan.md", { wait: true, preview: true }) // flip to preview on open, stay editable, read edits back on close
 */
export const openFile = async (file: string, options?: OpenOptions): Promise<string | null> => {
    const { line = 1, column = null, wait = false, preview = false, cwd = process.cwd() } = options ?? {}
    const launchFn = options?.deps?.launch ?? launch
    const setPreviewFn = options?.deps?.setPreview ?? setPreview
    const target = path.resolve(file)
    const args = ["--line", String(line)]
    if (column !== null) {
        args.push("--column", String(column))
    }
    args.push(target)
    // Start the launch but DON'T await it before the preview flip. With `wait`,
    // the IDE's native --wait blocks until the tab closes, so awaiting here first
    // would defer setPreview until AFTER the user is done — and setPreview reopens
    // the file, so it would pop the just-closed tab back up in preview. launch()
    // spawns synchronously (the file is already opening by the time it yields), so
    // setPreview can flip the layout while the wait is still blocking. On the
    // fire-and-forget path launch() resolves on spawn, so the order is unchanged;
    // on --dry-run effect() is disabled, `launching` resolves undefined, and the
    // awaits below are no-ops.
    const launching = effect(() => launchFn(args, { wait }))
    if (preview) {
        await effect(() => setPreviewFn(target, cwd))
    }
    await launching
    return wait ? await fs.readFile(file, { encoding: "utf8" }) : null
}

const command = defineCommand({
    name: "open-file",
    description: "Open a file in the running JetBrains IDE.",
    arguments: [{ name: "path", description: "file to open", required: true }],
    options: [
        { name: "line", arity: 1, hint: "n", description: "1-based caret line", coerce: integer },
        { name: "column", arity: 1, hint: "n", description: "1-based caret column", coerce: integer },
        {
            name: "wait",
            arity: 0,
            description: "block until the tab closes, then print the file back"
        },
        { name: "preview", arity: 0, description: "flip the editor to the rendered preview" }
    ],
    run: async ({ path: file, line, column, wait, preview }) => {
        assertIdea()
        const contents = await openFile(file, { line, column, wait, preview })
        if (contents !== null) {
            process.stdout.write(contents)
        }
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
