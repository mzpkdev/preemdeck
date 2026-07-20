#!/usr/bin/env bun
/**
 * html-dialog.ts — CLI wrapper over the reusable JCEF DialogWrapper utility.
 *
 * Exactly one trusted source is accepted: literal HTML, an HTML file, or a
 * loopback URL. The final line on stdout is always the machine-readable result.
 */

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { CmdoreError, defineCommand, effect, execute } from "cmdore"
import {
    DEFAULT_HTML_DIALOG_HEIGHT,
    DEFAULT_HTML_DIALOG_TIMEOUT_MS,
    DEFAULT_HTML_DIALOG_TITLE,
    DEFAULT_HTML_DIALOG_WIDTH,
    type HtmlDialogOptions,
    type HtmlDialogResult,
    type HtmlDialogSource,
    normalizeHtmlDialogOptions,
    showHtmlDialog
} from "./core"
import { integer } from "./core/coercers"

export type HtmlDialogCliInput = {
    html?: string
    htmlFile?: string
    url?: string
    title?: string
    width?: number
    height?: number
    timeoutMs?: number
}

export type HtmlDialogCliDeps = {
    readFile?: (path: string, encoding: "utf8") => Promise<string>
    showHtmlDialog?: (options: HtmlDialogOptions) => Promise<HtmlDialogResult>
}

const usageError = (message: string): never => {
    throw new CmdoreError(message, { exitCode: 2 })
}

/** Resolve exactly one CLI source, reading --html-file before the IDE call. */
export const resolveHtmlDialogCliSource = async (
    input: Pick<HtmlDialogCliInput, "html" | "htmlFile" | "url">,
    read: (path: string, encoding: "utf8") => Promise<string> = readFile
): Promise<HtmlDialogSource> => {
    const selected = [input.html !== undefined, input.htmlFile !== undefined, input.url !== undefined].filter(Boolean)
    if (selected.length !== 1) {
        usageError("exactly one of --html, --html-file, or --url is required")
    }
    if (input.html !== undefined) return { html: input.html }
    if (input.htmlFile !== undefined) return { html: await read(resolve(input.htmlFile), "utf8") }
    return { url: input.url as string }
}

export type HtmlDialogCliOutcome = { result: HtmlDialogResult; exitCode: number }

/** Show the modal, print its JSON result, and derive the CLI scripting code. */
export const htmlDialogCli = async (
    input: HtmlDialogCliInput,
    deps: HtmlDialogCliDeps = {}
): Promise<HtmlDialogCliOutcome> => {
    const source = await resolveHtmlDialogCliSource(input, deps.readFile ?? readFile)
    const show = deps.showHtmlDialog ?? showHtmlDialog
    let options: HtmlDialogOptions
    try {
        options = normalizeHtmlDialogOptions({
            source,
            title: input.title,
            width: input.width,
            height: input.height,
            timeoutMs: input.timeoutMs
        })
    } catch (error) {
        usageError(error instanceof Error ? error.message : String(error))
    }

    // cmdore disables effect() under --dry-run. Return a typed result instead of
    // silently producing no output, so scripts can distinguish rehearsal from a
    // missing IDE or a human timeout.
    const live = (await effect(() => show(options))) as HtmlDialogResult | undefined
    const result: HtmlDialogResult = live ?? { status: "unavailable", reason: "dry-run" }
    process.stdout.write(`${JSON.stringify(result)}\n`)

    const exitCode =
        result.status === "timeout" || (result.status === "unavailable" && result.reason !== "dry-run") ? 1 : 0
    return { result, exitCode }
}

const command = defineCommand({
    name: "html-dialog",
    description: "Show trusted HTML in a native JetBrains JCEF modal and print its JSON result.",
    options: [
        { name: "html", arity: 1, hint: "markup", description: "literal trusted HTML" },
        { name: "html-file", arity: 1, hint: "path", description: "path to trusted HTML" },
        { name: "url", arity: 1, hint: "url", description: "trusted localhost/loopback HTTP(S) URL" },
        {
            name: "title",
            arity: 1,
            hint: "title",
            description: "native dialog title",
            defaultValue: () => DEFAULT_HTML_DIALOG_TITLE
        },
        {
            name: "width",
            arity: 1,
            hint: "px",
            description: "preferred content width",
            coerce: integer,
            defaultValue: () => DEFAULT_HTML_DIALOG_WIDTH
        },
        {
            name: "height",
            arity: 1,
            hint: "px",
            description: "preferred content height",
            coerce: integer,
            defaultValue: () => DEFAULT_HTML_DIALOG_HEIGHT
        },
        {
            name: "timeout-ms",
            arity: 1,
            hint: "ms",
            description: "maximum wait for submit or cancel",
            coerce: integer,
            defaultValue: () => DEFAULT_HTML_DIALOG_TIMEOUT_MS
        }
    ],
    run: async ({ html, "html-file": htmlFile, url, title, width, height, "timeout-ms": timeoutMs }) => {
        const { exitCode } = await htmlDialogCli({ html, htmlFile, url, title, width, height, timeoutMs })
        process.exitCode = exitCode
    }
})

if (import.meta.main) {
    await execute(command, { metadata: command })
    process.exit(process.exitCode ?? 0)
}
