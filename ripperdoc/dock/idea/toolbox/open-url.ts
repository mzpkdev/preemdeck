#!/usr/bin/env bun
import { defineCommand, effect, execute } from "cmdore"
import { parseUrl } from "../../../../lib/text.ts"
import { assertIdea } from "./assert-idea.ts"
import { IdeaError, previewUrl, resolveExecPath } from "./core"

/**
 * Open `url` in the running IDE's embedded JCEF web-preview tab. `resolveExecPath()`
 * is the single guard for a live IDE; the `previewUrl()` launch is wrapped in
 * `effect()` so `--dry-run` skips the real ideScript call.
 *
 * @param url - the http/https URL to load in the preview tab.
 * @param title - optional title for the preview tab.
 * @returns nothing; the side effect is the opened preview tab.
 *
 * @example
 * await openUrl("http://localhost:3000") // preview the dev server
 * await openUrl("https://example.com", "Docs") // preview with a titled tab
 */
export const openUrl = async (url: string, title?: string): Promise<void> => {
    await resolveExecPath()
    await effect(() => previewUrl(url, title))
}

const command = defineCommand({
    name: "open-url",
    description: "Open an http/https URL in the running JetBrains IDE's web preview.",
    arguments: [{ name: "url", description: "http/https URL to open", required: true }],
    options: [{ name: "title", arity: 1, hint: "title", description: "title for the preview tab" }],
    run: async ({ url, title }) => {
        assertIdea()
        // The IDE's JCEF preview only speaks http(s); reject anything else up front.
        if (!["http", "https"].includes(parseUrl(url).scheme)) {
            throw new IdeaError("url must be a non-empty http/https URL")
        }
        await openUrl(url, title)
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
