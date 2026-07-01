#!/usr/bin/env bun
import { defineCommand, effect, execute } from "cmdore"
import { assertIdea } from "./assert-idea"
import { IdeaError, previewUrl, resolveExecPath } from "./core"

/**
 * Open `url` in the running IDE's embedded JCEF web-preview tab. The live-IDE
 * guard (`resolveExecPath()`) and the `previewUrl()` launch are both side
 * effects, so they live inside one `effect()` — `--dry-run` skips the whole
 * block, neither resolving the IDE binary nor making the real ideScript call
 * (matching open-file.ts). Resolving outside `effect()` would make `--dry-run`
 * require a resolvable live IDE and throw where resolveExecPath isn't
 * implemented (e.g. Linux).
 *
 * @param url - the http/https URL to load in the preview tab.
 * @param title - optional title for the preview tab.
 * @param cwd - working directory used to target the terminal's window; defaults to `process.cwd()`.
 * @returns nothing; the side effect is the opened preview tab.
 *
 * @example
 * await openUrl("http://localhost:3000") // preview the dev server
 * await openUrl("https://example.com", "Docs") // preview with a titled tab
 */
export const openUrl = async (url: string, title?: string, cwd: string = process.cwd()): Promise<void> => {
    await effect(async () => {
        await resolveExecPath()
        await previewUrl(url, title, cwd)
    })
}

const command = defineCommand({
    name: "open-url",
    description: "Open an http/https URL in the running JetBrains IDE's web preview.",
    arguments: [{ name: "url", description: "http/https URL to open", required: true }],
    options: [
        { name: "title", arity: 1, hint: "title", description: "title for the preview tab" },
        { name: "verbose", arity: 0, description: "report diagnostic detail on stderr" }
    ],
    run: async ({ url, title, verbose }) => {
        assertIdea()
        if (verbose) {
            process.stderr.write(`open-url: ${url} (title=${title})\n`)
        }
        // The IDE's JCEF preview only speaks http(s); reject anything else up front.
        // Parse the scheme the forgiving way `new URL` does NOT — never throw, and
        // treat invalid/host-less input as "" so it falls through the gate below.
        let scheme = ""
        try {
            scheme = new URL(url).protocol.replace(/:$/, "").toLowerCase()
        } catch {}
        if (!["http", "https"].includes(scheme)) {
            throw new IdeaError("url must be a non-empty http/https URL")
        }
        await openUrl(url, title)
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
