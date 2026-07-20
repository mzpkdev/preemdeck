/**
 * html-dialog.ts — reusable HTML modal support for the live JetBrains IDE.
 *
 * A trusted preemdeck page is rendered in a JCEF browser inside DialogWrapper.
 * The page completes the modal through a tiny injected bridge:
 *
 *     window.preemdeckDialog.submit(jsonValue)
 *     window.preemdeckDialog.cancel()
 *
 * The IDE-side Groovy writes the result to runGroovyForResult's temp file, so
 * callers receive one typed result without depending on a host's ask-user tool.
 */

import { Buffer } from "node:buffer"
import { IdeaError } from "./errors"
import { escapeGroovy, GROOVY_RESULT_PENDING, groovyProjectByCwd, runGroovyForResult } from "./groovy"
import { inIdea, resolveExecPath } from "./index"

export const DEFAULT_HTML_DIALOG_TITLE = "PreemDeck"
export const DEFAULT_HTML_DIALOG_WIDTH = 520
export const DEFAULT_HTML_DIALOG_HEIGHT = 360
export const DEFAULT_HTML_DIALOG_TIMEOUT_MS = 300_000

const MIN_DIALOG_WIDTH = 240
const MAX_DIALOG_WIDTH = 1_600
const MIN_DIALOG_HEIGHT = 160
const MAX_DIALOG_HEIGHT = 1_200
const MIN_DIALOG_TIMEOUT_MS = 1_000
const MAX_DIALOG_TIMEOUT_MS = 86_400_000
const RESULT_TRANSPORT_GRACE_MS = 5_000

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type HtmlDialogSource = { html: string } | { url: string }

export type HtmlDialogUnavailableReason = "not-in-idea" | "jcef-unsupported" | "jcef-load-failed" | "dry-run"

export type HtmlDialogResult =
    | { status: "submitted"; value: JsonValue }
    | { status: "cancelled" }
    | { status: "unavailable"; reason: HtmlDialogUnavailableReason; detail?: string }
    | { status: "timeout" }

export type HtmlDialogOptions = {
    source: HtmlDialogSource
    title?: string
    width?: number
    height?: number
    timeoutMs?: number
    /** Working directory used to select the owning project window. */
    cwd?: string
}

type NormalizedHtmlDialogOptions = {
    source: HtmlDialogSource
    title: string
    width: number
    height: number
    timeoutMs: number
    cwd: string
}

type RunDialogGroovy = (
    buildGroovy: (resultPath: string) => string,
    note: string,
    execPaths: readonly string[],
    timeoutMs: number
) => Promise<string | null>

export type HtmlDialogDeps = {
    inIdea?: () => boolean
    resolveExecPath?: () => Promise<string>
    runGroovyForResult?: RunDialogGroovy
}

const defaultRunDialogGroovy: RunDialogGroovy = async (buildGroovy, note, execPaths, timeoutMs) =>
    await runGroovyForResult(buildGroovy, note, execPaths, { timeoutMs })

const isLoopbackHost = (hostname: string): boolean => {
    const normalized = hostname.toLowerCase()
    return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]"
}

/** Parse and enforce the URL source's local-only boundary. */
export const validateHtmlDialogUrl = (raw: string): string => {
    let parsed: URL
    try {
        parsed = new URL(raw)
    } catch {
        throw new Error("dialog URL must be a valid absolute URL")
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("dialog URL must use http or https")
    }
    if (!isLoopbackHost(parsed.hostname)) {
        throw new Error("dialog URL must use localhost, 127.0.0.1, or ::1")
    }
    if (parsed.username || parsed.password) {
        throw new Error("dialog URL must not contain credentials")
    }
    return parsed.toString()
}

const boundedInteger = (value: number, label: string, min: number, max: number): number => {
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${label} must be an integer from ${min} to ${max}`)
    }
    return value
}

/** Normalize defaults and reject malformed runtime input before Groovy is built. */
export const normalizeHtmlDialogOptions = (options: HtmlDialogOptions): NormalizedHtmlDialogOptions => {
    const source = options.source
    const hasHtml = "html" in source
    const hasUrl = "url" in source
    if (hasHtml === hasUrl) {
        throw new Error("dialog source must contain exactly one of html or url")
    }

    let normalizedSource: HtmlDialogSource
    if (hasHtml) {
        if (typeof source.html !== "string" || source.html.trim().length === 0) {
            throw new Error("dialog HTML must be a non-empty string")
        }
        normalizedSource = { html: source.html }
    } else {
        normalizedSource = { url: validateHtmlDialogUrl(source.url) }
    }

    const title = options.title ?? DEFAULT_HTML_DIALOG_TITLE
    if (typeof title !== "string" || title.trim().length === 0) {
        throw new Error("dialog title must be a non-empty string")
    }

    return {
        source: normalizedSource,
        title,
        width: boundedInteger(
            options.width ?? DEFAULT_HTML_DIALOG_WIDTH,
            "dialog width",
            MIN_DIALOG_WIDTH,
            MAX_DIALOG_WIDTH
        ),
        height: boundedInteger(
            options.height ?? DEFAULT_HTML_DIALOG_HEIGHT,
            "dialog height",
            MIN_DIALOG_HEIGHT,
            MAX_DIALOG_HEIGHT
        ),
        timeoutMs: boundedInteger(
            options.timeoutMs ?? DEFAULT_HTML_DIALOG_TIMEOUT_MS,
            "dialog timeout",
            MIN_DIALOG_TIMEOUT_MS,
            MAX_DIALOG_TIMEOUT_MS
        ),
        cwd: options.cwd ?? process.cwd()
    }
}

const isJsonValue = (value: unknown): value is JsonValue => {
    if (value === null || ["boolean", "string"].includes(typeof value)) return true
    if (typeof value === "number") return Number.isFinite(value)
    if (Array.isArray(value)) return value.every(isJsonValue)
    if (typeof value !== "object") return false
    return Object.values(value as Record<string, unknown>).every(isJsonValue)
}

/** Parse the one JSON result written by the IDE-side modal. */
export const parseHtmlDialogResult = (raw: string | null): HtmlDialogResult => {
    if (raw === null) return { status: "timeout" }

    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        throw new Error("IDE returned malformed dialog JSON")
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("IDE returned an invalid dialog result")
    }

    const record = parsed as Record<string, unknown>
    if (record.status === "submitted" && "value" in record && isJsonValue(record.value)) {
        return { status: "submitted", value: record.value }
    }
    if (record.status === "cancelled") return { status: "cancelled" }
    if (record.status === "timeout") return { status: "timeout" }
    if (
        record.status === "unavailable" &&
        ["jcef-unsupported", "jcef-load-failed"].includes(record.reason as string) &&
        (record.detail === undefined || typeof record.detail === "string")
    ) {
        return {
            status: "unavailable",
            reason: record.reason as "jcef-unsupported" | "jcef-load-failed",
            ...(record.detail === undefined ? {} : { detail: record.detail as string })
        }
    }
    throw new Error("IDE returned an unknown dialog result")
}

const groovySourceLoader = (source: HtmlDialogSource): string => {
    if ("html" in source) {
        const encoded = Buffer.from(source.html, "utf8").toString("base64")
        return `        def html = new String(Base64.getDecoder().decode("${encoded}"), StandardCharsets.UTF_8)
        browser.loadHTML(html)`
    }
    return `        browser.loadURL("${escapeGroovy(source.url)}")`
}

/**
 * Build the complete result-producing Groovy script. Kept pure so CI can check
 * the bridge and lifecycle without starting a real IDE or JCEF runtime.
 */
export const groovyHtmlDialog = (input: HtmlDialogOptions, resultPath: string): string => {
    const options = normalizeHtmlDialogOptions(input)
    const out = escapeGroovy(resultPath)
    const title = escapeGroovy(options.title)
    const cwd = escapeGroovy(options.cwd)
    const loadSource = groovySourceLoader(options.source)

    return `import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefJSQuery
import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import java.awt.Dimension
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.Base64
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import javax.swing.Action
import javax.swing.JComponent
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandlerAdapter

def out = Path.of("${out}")
Files.writeString(out, "${GROOVY_RESULT_PENDING}", StandardCharsets.UTF_8)

ApplicationManager.getApplication().invokeLater {
    if (!JBCefApp.isSupported()) {
        Files.writeString(out, JsonOutput.toJson([status: "unavailable", reason: "jcef-unsupported"]), StandardCharsets.UTF_8)
        return
    }

    def projects = ProjectManager.getInstance().getOpenProjects()
    def cwd = "${cwd}"
${groovyProjectByCwd({ fallback: "projects.length > 0 ? projects[0] : null", indent: "    " })}
    def answered = new AtomicBoolean(false)
    def dialogRef = new AtomicReference()
    def browser = new JBCefBrowser()
    def query = JBCefJSQuery.create(browser)
    def write = { value -> Files.writeString(out, JsonOutput.toJson(value), StandardCharsets.UTF_8) }
    def timeoutTimer = new javax.swing.Timer(${options.timeoutMs}, { event ->
        if (answered.compareAndSet(false, true)) {
            write([status: "timeout"])
            dialogRef.get()?.close(DialogWrapper.CANCEL_EXIT_CODE)
        }
    })
    timeoutTimer.setRepeats(false)
    def sourceTimer = new javax.swing.Timer(0, { event ->
        try {
${loadSource}
        } catch (error) {
            if (answered.compareAndSet(false, true)) {
                write([status: "unavailable", reason: "jcef-load-failed", detail: error.getClass().getName() + ": " + error.getMessage()])
                dialogRef.get()?.close(DialogWrapper.CANCEL_EXIT_CODE)
            }
        }
    })
    sourceTimer.setRepeats(false)

    query.addHandler { request ->
        try {
            def message = new JsonSlurper().parseText(request)
            def result = message.action == "cancel"
                ? [status: "cancelled"]
                : message.action == "submit"
                    ? [status: "submitted", value: message.value]
                    : null
            if (result != null && answered.compareAndSet(false, true)) {
                write(result)
                ApplicationManager.getApplication().invokeLater {
                    dialogRef.get()?.close(DialogWrapper.OK_EXIT_CODE)
                }
            }
        } catch (ignored) {
            // A malformed page message leaves the dialog open for a valid retry.
        }
        return null
    }

    def submitCall = query.inject("envelope")
    def bridgeJs = """
        (function () {
            window.preemdeckDialog = Object.freeze({
                submit: function (value) {
                    var envelope;
                    try {
                        envelope = JSON.stringify({action: "submit", value: value === undefined ? null : value});
                    } catch (error) {
                        return false;
                    }
                    \${submitCall}
                    return true;
                },
                cancel: function () {
                    var envelope = JSON.stringify({action: "cancel"});
                    \${submitCall}
                    return true;
                }
            });
            window.dispatchEvent(new CustomEvent("preemdeck-dialog-ready"));
        })();
    """
    def loadHandler = new CefLoadHandlerAdapter() {
        @Override
        void onLoadEnd(CefBrowser cefBrowser, CefFrame frame, int httpStatusCode) {
            if (frame.isMain()) {
                cefBrowser.executeJavaScript(bridgeJs, cefBrowser.getURL(), 0)
            }
        }
    }
    browser.getJBCefClient().addLoadHandler(loadHandler, browser.getCefBrowser())

    def panel = browser.getComponent()
    panel.setPreferredSize(new Dimension(${options.width}, ${options.height}))
    def dialog = new DialogWrapper(project, true) {
        @Override
        protected JComponent createCenterPanel() { panel }

        @Override
        protected Action[] createActions() { [] as Action[] }
    }
    dialogRef.set(dialog)
    dialog.setTitle("${title}")
    dialog.init()
    timeoutTimer.start()
    sourceTimer.start()

    try {
        dialog.show()
    } finally {
        sourceTimer.stop()
        timeoutTimer.stop()
        if (answered.compareAndSet(false, true)) write([status: "cancelled"])
        query.dispose()
        browser.dispose()
    }
}
`
}

/** Show a trusted HTML modal in the owning JetBrains project window. */
export const showHtmlDialog = async (
    input: HtmlDialogOptions,
    deps: HtmlDialogDeps = {}
): Promise<HtmlDialogResult> => {
    const options = normalizeHtmlDialogOptions(input)
    const inIdeaFn = deps.inIdea ?? inIdea
    if (!inIdeaFn()) return { status: "unavailable", reason: "not-in-idea" }

    const resolve = deps.resolveExecPath ?? resolveExecPath
    let execPath: string
    try {
        execPath = await resolve()
    } catch (error) {
        if (error instanceof IdeaError) return { status: "unavailable", reason: "not-in-idea" }
        throw error
    }

    const run = deps.runGroovyForResult ?? defaultRunDialogGroovy
    const raw = await run(
        (resultPath) => groovyHtmlDialog(options, resultPath),
        "html-dialog: could not show modal",
        [execPath],
        options.timeoutMs + RESULT_TRANSPORT_GRACE_MS
    )
    return parseHtmlDialogResult(raw)
}
