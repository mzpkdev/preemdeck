import { describe, expect, it } from "bun:test"
import { IdeaError } from "./errors"
import {
    DEFAULT_HTML_DIALOG_HEIGHT,
    DEFAULT_HTML_DIALOG_TIMEOUT_MS,
    DEFAULT_HTML_DIALOG_TITLE,
    DEFAULT_HTML_DIALOG_WIDTH,
    groovyHtmlDialog,
    type HtmlDialogDeps,
    type HtmlDialogOptions,
    type HtmlDialogResult,
    normalizeHtmlDialogOptions,
    parseHtmlDialogResult,
    showHtmlDialog,
    validateHtmlDialogUrl
} from "./html-dialog"

describe("normalizeHtmlDialogOptions", () => {
    it("applies the reusable modal defaults", () => {
        expect(normalizeHtmlDialogOptions({ source: { html: "<p>Hello</p>" }, cwd: "/work" })).toEqual({
            source: { html: "<p>Hello</p>" },
            title: DEFAULT_HTML_DIALOG_TITLE,
            width: DEFAULT_HTML_DIALOG_WIDTH,
            height: DEFAULT_HTML_DIALOG_HEIGHT,
            timeoutMs: DEFAULT_HTML_DIALOG_TIMEOUT_MS,
            cwd: "/work"
        })
    })

    it("preserves explicit presentation and timeout options", () => {
        const normalized = normalizeHtmlDialogOptions({
            source: { url: "http://127.0.0.1:5173/form" },
            title: "Question",
            width: 640,
            height: 420,
            timeoutMs: 12_000,
            cwd: "/repo"
        })
        expect(normalized).toEqual({
            source: { url: "http://127.0.0.1:5173/form" },
            title: "Question",
            width: 640,
            height: 420,
            timeoutMs: 12_000,
            cwd: "/repo"
        })
    })

    it.each([
        ["empty HTML", { source: { html: "  " } }, "non-empty"],
        ["blank title", { source: { html: "x" }, title: "" }, "title"],
        ["small width", { source: { html: "x" }, width: 239 }, "width"],
        ["large width", { source: { html: "x" }, width: 1601 }, "width"],
        ["small height", { source: { html: "x" }, height: 159 }, "height"],
        ["large height", { source: { html: "x" }, height: 1201 }, "height"],
        ["short timeout", { source: { html: "x" }, timeoutMs: 999 }, "timeout"]
    ] as [string, HtmlDialogOptions, string][])("rejects %s", (_label, options, fragment) => {
        expect(() => normalizeHtmlDialogOptions(options)).toThrow(fragment)
    })

    it("rejects a runtime object containing both source kinds", () => {
        const source = { html: "x", url: "http://localhost:3000" } as unknown as HtmlDialogOptions["source"]
        expect(() => normalizeHtmlDialogOptions({ source })).toThrow("exactly one")
    })
})

describe("validateHtmlDialogUrl", () => {
    it.each([
        ["http://localhost:5173/a", "http://localhost:5173/a"],
        ["https://127.0.0.1:8443/", "https://127.0.0.1:8443/"],
        ["http://[::1]:3000/form", "http://[::1]:3000/form"]
    ])("accepts loopback URL %s", (raw, expected) => {
        expect(validateHtmlDialogUrl(raw)).toBe(expected)
    })

    it.each([
        ["relative URL", "/form", "absolute"],
        ["foreign host", "https://example.com/form", "localhost"],
        ["unsupported scheme", "file:///tmp/form.html", "http"],
        ["embedded credentials", "http://user:pass@localhost:3000", "credentials"]
    ])("rejects %s", (_label, raw, fragment) => {
        expect(() => validateHtmlDialogUrl(raw)).toThrow(fragment)
    })
})

describe("parseHtmlDialogResult", () => {
    it("maps no IDE answer to timeout", () => {
        expect(parseHtmlDialogResult(null)).toEqual({ status: "timeout" })
    })

    it("accepts nested JSON values", () => {
        expect(parseHtmlDialogResult('{"status":"submitted","value":{"choice":"mcp","tags":[1,true,null]}}')).toEqual({
            status: "submitted",
            value: { choice: "mcp", tags: [1, true, null] }
        })
    })

    it.each([
        ['{"status":"cancelled"}', { status: "cancelled" }],
        ['{"status":"timeout"}', { status: "timeout" }],
        ['{"status":"unavailable","reason":"jcef-unsupported"}', { status: "unavailable", reason: "jcef-unsupported" }],
        [
            '{"status":"unavailable","reason":"jcef-load-failed","detail":"MissingMethodException"}',
            { status: "unavailable", reason: "jcef-load-failed", detail: "MissingMethodException" }
        ]
    ] as [string, HtmlDialogResult][])("accepts terminal result %s", (raw, expected) => {
        expect(parseHtmlDialogResult(raw)).toEqual(expected)
    })

    it.each([
        "not-json",
        "null",
        '{"status":"submitted"}',
        '{"status":"wat"}'
    ])("rejects malformed/unknown result %s", (raw) => {
        expect(() => parseHtmlDialogResult(raw)).toThrow()
    })
})

describe("groovyHtmlDialog", () => {
    const base: HtmlDialogOptions = {
        source: { html: '<button onclick="window.preemdeckDialog.submit(42)">Pick</button>' },
        title: 'Question "One"',
        width: 600,
        height: 400,
        timeoutMs: 10_000,
        cwd: "C:\\work"
    }

    it("builds the native JCEF modal, page bridge, and result protocol", () => {
        const groovy = groovyHtmlDialog(base, 'C:\\tmp\\result".json')

        expect(groovy).toContain("JBCefApp.isSupported()")
        expect(groovy).toContain("new JBCefBrowser()")
        expect(groovy).toContain("JBCefJSQuery.create(browser)")
        expect(groovy).toContain("new DialogWrapper(project, true)")
        expect(groovy).toContain("window.preemdeckDialog = Object.freeze")
        expect(groovy).toContain('query.inject("envelope")')
        expect(groovy).toContain('status: "submitted"')
        expect(groovy).toContain('status: "cancelled"')
        expect(groovy).toContain('status: "timeout"')
        expect(groovy).toContain('reason: "jcef-unsupported"')
        expect(groovy).toContain('reason: "jcef-load-failed"')
        expect(groovy).toContain("new javax.swing.Timer(10000")
        expect(groovy).toContain("new javax.swing.Timer(0")
        expect(groovy).toContain("query.dispose()")
        expect(groovy).toContain("browser.dispose()")
    })

    it("threads presentation options and safely escapes Groovy literals", () => {
        const groovy = groovyHtmlDialog(base, 'C:\\tmp\\result".json')
        expect(groovy).toContain("new Dimension(600, 400)")
        expect(groovy).toContain('dialog.setTitle("Question \\"One\\"")')
        expect(groovy).toContain('def cwd = "C:\\\\work"')
        expect(groovy).toContain('Path.of("C:\\\\tmp\\\\result\\".json")')
    })

    it("base64-encodes inline HTML instead of interpolating it into Groovy", () => {
        const groovy = groovyHtmlDialog(base, "/tmp/result.json")
        expect(groovy).toContain("Base64.getDecoder().decode")
        expect(groovy).toContain("browser.loadHTML(html)")
        expect(groovy).not.toContain("<button")
    })

    it("loads a validated loopback URL directly", () => {
        const groovy = groovyHtmlDialog(
            { source: { url: "http://localhost:5173/question?id=1" }, cwd: "/repo" },
            "/tmp/result.json"
        )
        expect(groovy).toContain('browser.loadURL("http://localhost:5173/question?id=1")')
        expect(groovy).not.toContain("Base64.getDecoder().decode")
    })

    it("selects the project window by cwd", () => {
        const groovy = groovyHtmlDialog(base, "/tmp/result.json")
        expect(groovy).toContain("projects.each { p ->")
        expect(groovy).toContain('cwd == bp || cwd.startsWith(bp + "/")')
    })
})

describe("showHtmlDialog", () => {
    const input: HtmlDialogOptions = {
        source: { html: "<p>Question</p>" },
        timeoutMs: 12_000,
        cwd: "/repo"
    }

    it("returns unavailable without resolving or dispatching outside IDEA", async () => {
        let resolved = false
        let dispatched = false
        const result = await showHtmlDialog(input, {
            inIdea: () => false,
            resolveExecPath: async () => {
                resolved = true
                return "/idea"
            },
            runGroovyForResult: async () => {
                dispatched = true
                return null
            }
        })
        expect(result).toEqual({ status: "unavailable", reason: "not-in-idea" })
        expect(resolved).toBe(false)
        expect(dispatched).toBe(false)
    })

    it("maps a stale owning IDE resolution to unavailable", async () => {
        const result = await showHtmlDialog(input, {
            inIdea: () => true,
            resolveExecPath: async () => {
                throw new IdeaError("gone")
            }
        })
        expect(result).toEqual({ status: "unavailable", reason: "not-in-idea" })
    })

    it("dispatches to the owning launcher with the requested human timeout", async () => {
        const calls: Array<{ note: string; paths: readonly string[]; timeout: number; groovy: string }> = []
        const deps: HtmlDialogDeps = {
            inIdea: () => true,
            resolveExecPath: async () => "/opt/webstorm/bin/webstorm",
            runGroovyForResult: async (build, note, paths, timeout) => {
                calls.push({ note, paths, timeout, groovy: build("/tmp/result.json") })
                return '{"status":"submitted","value":"mcp"}'
            }
        }
        const result = await showHtmlDialog(input, deps)
        expect(result).toEqual({ status: "submitted", value: "mcp" })
        expect(calls).toHaveLength(1)
        expect(calls[0]?.paths).toEqual(["/opt/webstorm/bin/webstorm"])
        expect(calls[0]?.timeout).toBe(17_000)
        expect(calls[0]?.groovy).toContain("/tmp/result.json")
    })

    it("maps a result bridge miss to timeout", async () => {
        const result = await showHtmlDialog(input, {
            inIdea: () => true,
            resolveExecPath: async () => "/idea",
            runGroovyForResult: async () => null
        })
        expect(result).toEqual({ status: "timeout" })
    })

    it("does not hide unexpected launcher failures", async () => {
        await expect(
            showHtmlDialog(input, {
                inIdea: () => true,
                resolveExecPath: async () => {
                    throw new TypeError("boom")
                }
            })
        ).rejects.toBeInstanceOf(TypeError)
    })
})
