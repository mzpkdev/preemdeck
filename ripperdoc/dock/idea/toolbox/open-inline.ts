#!/usr/bin/env bun
import * as fs from "node:fs/promises"
import { defineCommand, execute } from "cmdore"
import { assertIdea } from "./assert-idea.ts"
import { reapLater } from "./core"
import { boolean } from "./core/coercers.ts"
import { openFile } from "./open-file.ts"
import { writeTemp } from "./tmp.ts"

export type OpenInlineOptions = {
    suffix?: string
    wait?: boolean
    preview?: boolean
}

/**
 * Open `content` in the running JetBrains IDE by routing it through a temp file.
 * On `wait` the open blocks, returns the edited text, then unlinks the temp; on
 * fire-and-forget the open is launched async and the temp is reaped later.
 *
 * @param content - the inline string to drop into a temp file and open.
 * @param options - temp-file suffix and wait/preview behavior; see {@link OpenInlineOptions}.
 * @returns the edited utf8 contents on the `wait` path, else null.
 *
 * @example
 * await openInline("draft note", { suffix: ".md" }) // open a scratch buffer, fire-and-forget
 * const edited = await openInline("TODO", { wait: true }) // block until closed, then read back
 */
export const openInline = async (content: string, options: OpenInlineOptions = {}): Promise<string | null> => {
    const suffix = options.suffix ?? ".txt"
    const wait = options.wait ?? false
    const preview = options.preview ?? false

    const path = await writeTemp(content, suffix)
    try {
        const contents = await openFile(path, { wait, preview })
        if (wait) {
            return contents
        }
        // Fire-and-forget: the IDE is (or will be) reading `path`, so deleting it
        // now would yank the file out from under the editor.
        reapLater([path])
        return null
    } finally {
        if (wait) {
            await fs.unlink(path)
        }
    }
}

const command = defineCommand({
    name: "open-inline",
    description: "Open an inline string in the running JetBrains IDE via a temp file.",
    arguments: [{ name: "inline", description: "string to open", required: true }],
    options: [
        { name: "suffix", arity: 1, hint: "ext", description: "temp-file suffix (drives IDE syntax highlighting)" },
        {
            name: "wait",
            arity: 0,
            description: "block until the tab closes, then print the file back",
            coerce: boolean
        },
        {
            name: "preview",
            arity: 0,
            description: "flip the editor to the rendered preview after opening",
            coerce: boolean
        }
    ],
    run: async ({ inline, suffix, wait, preview }) => {
        assertIdea()
        const contents = await openInline(inline, { suffix: suffix ?? ".txt", wait, preview })
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
