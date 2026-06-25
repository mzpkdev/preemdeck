#!/usr/bin/env bun
/**
 * open-inline.ts — open an inline string in the running JetBrains IDE via a temp
 * file.
 *
 * A thin string-native wrapper over openFile: the string is spilled to a temp
 * file (named with `suffix` so the IDE picks the right syntax highlighting),
 * opened, and — on the wait path — the edited text is handed back. The IDE only
 * opens files, so the temp is the bridge.
 *
 * The CLI is a cmdore commandless command: cmdore owns parsing, help, the global
 * flags (--quiet/--verbose/--json/--dry-run/--help/--version), and exit codes.
 * main() wraps execute() with onError:"throw" so it can keep the repo CLI shape
 * (return a number; process.exit only under the import.meta.main guard) and map
 * IdeaError / CmdoreError to the open-inline: prefixed stderr line. openInline's
 * OWN effects (writeTemp, reapLater) stay real & seam-free; the reach-through to
 * the IDE bottoms out in open-file's launch/setPreview wrappers.
 */

import { unlink } from "node:fs/promises"
import { CmdoreError, defineCommand, execute } from "cmdore"
import { IdeaError } from "./core/errors.ts"
import { inIdea, reapLater } from "./core/index.ts"
import { open } from "./open-file.ts"
import { writeTemp } from "./tmp.ts"

const PROG = "open-inline"

/** cmdore metadata for the commandless CLI; version mirrors the idea plugin manifest. */
const METADATA = {
    name: PROG,
    version: "0.1.0",
    description: "Open an inline string in the running JetBrains IDE via a temp file."
} as const

/** Options for {@link openInline}: the temp-file suffix (drives IDE syntax highlighting), the wait toggle, and the rendered-preview opt-in. */
export type OpenInlineOptions = {
    suffix?: string
    wait?: boolean
    preview?: boolean
}

/**
 * Open `content` in the running JetBrains IDE by routing it through a temp file.
 *
 * wait=true  -> openFile blocks and returns the edited text; unlink the temp,
 *   return the text. wait=false -> openFile launched async; schedule a deferred
 *   reap (reapLater) and return null.
 */
export const openInline = async (content: string, options: OpenInlineOptions = {}): Promise<string | null> => {
    const suffix = options.suffix ?? ".txt"
    const wait = options.wait ?? false
    const preview = options.preview ?? false

    const path = await writeTemp(content, suffix)
    try {
        const contents = await open(path, { wait, preview })
        if (wait) {
            return contents
        }
        // Fire-and-forget: the IDE was launched async and is (or will be) reading
        // `path`, so deleting it now would yank the file out from under the editor.
        reapLater([path])
        return null
    } finally {
        // Only the wait=true path is safe to clean up synchronously here.
        if (wait) {
            await unlink(path)
        }
    }
}

/**
 * The cmdore command behind the CLI. Gates on a live IDE (cheap fail-fast before
 * openFile's launch() deeper ancestry walk), runs openInline, and on the --wait
 * path writes the edited file text to stdout verbatim (no trailing newline).
 */
const openInlineCommand = defineCommand({
    name: PROG,
    description: METADATA.description,
    arguments: [{ name: "inline", description: "string to open", required: true }],
    options: [
        { name: "suffix", arity: 1, hint: "ext", description: "temp-file suffix (drives IDE syntax highlighting)" },
        { name: "wait", arity: 0, description: "block until the tab closes, then print the file back" },
        { name: "preview", arity: 0, description: "flip the editor to the rendered preview after opening" }
    ],
    run: async ({ inline, suffix, wait, preview }) => {
        if (!inIdea()) {
            throw new IdeaError("no JetBrains IDE in the process ancestry")
        }
        const contents = await openInline(inline, { suffix: suffix ?? ".txt", wait, preview })
        if (contents !== null) {
            process.stdout.write(contents)
        }
    }
})

/**
 * CLI entrypoint. Hands argv to cmdore (parsing, help, global flags), then maps
 * the two domain failures to the open-inline: stderr line and their exit codes:
 * IdeaError -> 1, CmdoreError (bad flag / missing inline) -> its own exitCode.
 * Anything else is a bug and rethrown.
 */
export const main = async (argv: string[] = Bun.argv.slice(2)): Promise<number> => {
    try {
        await execute(openInlineCommand, { argv, metadata: METADATA, onError: "throw" })
    } catch (error) {
        if (error instanceof IdeaError) {
            process.stderr.write(`${PROG}: ${error.message}\n`)
            return 1
        }
        if (error instanceof CmdoreError) {
            process.stderr.write(`${PROG}: ${error.message}\n`)
            return error.exitCode
        }
        throw error
    }
    return 0
}

if (import.meta.main) {
    process.exit(await main())
}
