#!/usr/bin/env bun
/**
 * open-url.ts — open an http/https URL in the running JetBrains IDE's embedded
 * JCEF preview.
 *
 * FIRE-AND-FORGET: there is no editor to block on, so unlike open-file there is
 * no --wait. Clean-fail, NOT a browser fallback: resolveExecPath() is the single
 * guard for a live IDE — it throws IdeaError / NotImplementedError; the CLI turns
 * either into a non-zero exit. With a live IDE confirmed, previewUrl() fires the
 * ideScript.
 *
 * The CLI is a cmdore commandless command: cmdore owns parsing, help, the global
 * flags (--quiet/--verbose/--json/--dry-run/--help/--version), and exit codes.
 * main() wraps execute() with onError:"throw" so it can keep the repo CLI shape
 * (return a number; process.exit only under the import.meta.main guard) and map
 * IdeaError / CmdoreError to the open-url: prefixed stderr line.
 */

import { CmdoreError, defineCommand, effect, execute } from "cmdore"
import { parseUrl } from "../../../../lib/text.ts"
import { IdeaError, NotImplementedError } from "./core/errors.ts"
import { inIdea, previewUrl as rawPreviewUrl, resolveExecPath } from "./core/index.ts"

const PROG = "open-url"

/** cmdore metadata for the commandless CLI; version mirrors the idea plugin manifest. */
const METADATA = {
    name: PROG,
    version: "0.1.0",
    description: "Open an http/https URL in the running JetBrains IDE's web preview."
} as const

/**
 * The write side-effect, wrapped as cmdore `effect.fn` so it is skipped on
 * `--dry-run` (when cmdore flips `effect.enabled` off) and mockable in tests by
 * the WRAPPER REFERENCE (`effect.mock(previewUrl, …)`) — no per-file mutable
 * seam. `resolveExecPath` is the live-IDE READ guard and stays unwrapped.
 */
export const previewUrl = effect.fn(rawPreviewUrl, "ide.previewUrl")

/**
 * Open `url` in the running IDE's embedded JCEF web-preview tab. resolveExecPath()
 * is the single guard for a live IDE; then previewUrl() fires the ideScript.
 */
export const openUrl = async (url: string, title?: string): Promise<void> => {
    await resolveExecPath()
    await previewUrl(url, title)
}

/**
 * The cmdore command behind the CLI. Validates the http(s) URL, gates on a live
 * IDE (cheap fail-fast before resolveExecPath()'s deeper ancestry walk), then
 * runs openUrl.
 */
const openUrlCommand = defineCommand({
    name: PROG,
    description: METADATA.description,
    arguments: [{ name: "url", description: "http/https URL to open", required: true }],
    options: [{ name: "title", arity: 1, hint: "title", description: "title for the preview tab" }],
    run: async ({ url, title }) => {
        // Light validation: a non-empty http/https URL. The IDE's JCEF preview only
        // speaks http(s), so reject anything else up front with a clear note.
        if (!["http", "https"].includes(parseUrl(url).scheme)) {
            throw new IdeaError("url must be a non-empty http/https URL")
        }
        if (!inIdea()) {
            throw new IdeaError("no JetBrains IDE in the process ancestry")
        }
        await openUrl(url, title)
    }
})

/**
 * CLI entrypoint. Hands argv to cmdore (parsing, help, global flags), then maps
 * the domain failures to the open-url: stderr line and their exit codes:
 * IdeaError / NotImplementedError -> 1, CmdoreError (missing/unknown arg) -> its
 * own exitCode. Anything else is a bug and rethrown.
 */
export const main = async (argv: string[] = Bun.argv.slice(2)): Promise<number> => {
    try {
        await execute(openUrlCommand, { argv, metadata: METADATA, onError: "throw" })
    } catch (error) {
        if (error instanceof IdeaError || error instanceof NotImplementedError) {
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
