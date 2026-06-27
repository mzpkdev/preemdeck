import { describe, expect, it } from "bun:test"
import { IdeaError, NotImplementedError } from "./errors.ts"
import type { RunGroovyDeps } from "./groovy.ts"
import { previewUrl, setPreview, webpreviewOpenBody } from "./preview.ts"

const context = describe

// --- GOLDEN OUTPUTS (byte-identical to the reference engine) --------------------

const GOLDEN_SETLAYOUT_MD = `import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.TextEditorWithPreview
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ide.DataManager

ApplicationManager.getApplication().invokeLater {
    def vFile = LocalFileSystem.getInstance().findFileByPath("/Users/me/notes.md")
    if (vFile == null) return
    def projects = ProjectManager.getInstance().getOpenProjects()
    if (projects.length == 0) return
    def cwd = "/Users/me/proj"
    def project = projects[0]
    def bestLen = -1
    projects.each { p ->
        def bp = p.getBasePath()
        if (bp != null && (cwd == bp || cwd.startsWith(bp + "/")) && bp.length() > bestLen) {
            project = p
            bestLen = bp.length()
        }
    }
    def manager = FileEditorManager.getInstance(project)
    manager.openFile(vFile, true)
    def editor = manager.getSelectedEditor(vFile)
    if (editor instanceof TextEditorWithPreview) {
        editor.setLayout(TextEditorWithPreview.Layout.SHOW_PREVIEW)
    }
}
`

const GOLDEN_WEBPREVIEW_HTML = `import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.util.registry.Registry
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.util.Urls
import com.intellij.ide.browsers.actions.WebPreviewVirtualFile

ApplicationManager.getApplication().invokeLater {
    try {
        def projects = ProjectManager.getInstance().getOpenProjects()
        if (projects.length == 0) return
        def cwd = "/Users/me/proj"
        def project = projects[0]
        def bestLen = -1
        projects.each { p ->
            def bp = p.getBasePath()
            if (bp != null && (cwd == bp || cwd.startsWith(bp + "/")) && bp.length() > bestLen) {
                project = p
                bestLen = bp.length()
            }
        }
        def vFile = LocalFileSystem.getInstance().refreshAndFindFileByPath("/Users/me/page.html")
        if (vFile == null) return
        if (!(Registry.is("ide.web.preview.enabled") && Registry.is("ide.browser.jcef.enabled"))) return
        def url = Urls.newFromVirtualFile(vFile)
        def previewFile = new WebPreviewVirtualFile(vFile, url)
        FileEditorManager.getInstance(project).openFile(previewFile, true)
    } catch (Throwable t) {
        t.printStackTrace()
    }
}
`

const GOLDEN_SETLAYOUT_ESCAPED = `import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.TextEditorWithPreview
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ide.DataManager

ApplicationManager.getApplication().invokeLater {
    def vFile = LocalFileSystem.getInstance().findFileByPath("/tmp/we\\"ird\\\\name.md")
    if (vFile == null) return
    def projects = ProjectManager.getInstance().getOpenProjects()
    if (projects.length == 0) return
    def cwd = "/Users/me/proj"
    def project = projects[0]
    def bestLen = -1
    projects.each { p ->
        def bp = p.getBasePath()
        if (bp != null && (cwd == bp || cwd.startsWith(bp + "/")) && bp.length() > bestLen) {
            project = p
            bestLen = bp.length()
        }
    }
    def manager = FileEditorManager.getInstance(project)
    manager.openFile(vFile, true)
    def editor = manager.getSelectedEditor(vFile)
    if (editor instanceof TextEditorWithPreview) {
        editor.setLayout(TextEditorWithPreview.Layout.SHOW_PREVIEW)
    }
}
`

const GOLDEN_URL_HOSTPORT = `import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.ProjectManager

ApplicationManager.getApplication().invokeLater {
    try {
        def projects = ProjectManager.getInstance().getOpenProjects()
        if (projects.length == 0) return
        def cwd = "/Users/me/proj"
        def project = projects[0]
        def bestLen = -1
        projects.each { p ->
            def bp = p.getBasePath()
            if (bp != null && (cwd == bp || cwd.startsWith(bp + "/")) && bp.length() > bestLen) {
                project = p
                bestLen = bp.length()
            }
        }
        if (!(com.intellij.openapi.util.registry.Registry.is("ide.web.preview.enabled") && com.intellij.openapi.util.registry.Registry.is("ide.browser.jcef.enabled"))) return
        def url = com.intellij.util.Urls.newFromEncoded("http://localhost:3000")
        def dummy = new com.intellij.testFramework.LightVirtualFile("localhost:3000")
        def previewFile = new com.intellij.ide.browsers.actions.WebPreviewVirtualFile(dummy, url)
        com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFile(previewFile, true)
    } catch (Throwable t) {
        t.printStackTrace()
    }
}
`

const GOLDEN_URL_QUERY_SPECIALS = `import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.ProjectManager

ApplicationManager.getApplication().invokeLater {
    try {
        def projects = ProjectManager.getInstance().getOpenProjects()
        if (projects.length == 0) return
        def cwd = "/Users/me/proj"
        def project = projects[0]
        def bestLen = -1
        projects.each { p ->
            def bp = p.getBasePath()
            if (bp != null && (cwd == bp || cwd.startsWith(bp + "/")) && bp.length() > bestLen) {
                project = p
                bestLen = bp.length()
            }
        }
        if (!(com.intellij.openapi.util.registry.Registry.is("ide.web.preview.enabled") && com.intellij.openapi.util.registry.Registry.is("ide.browser.jcef.enabled"))) return
        def url = com.intellij.util.Urls.newFromEncoded("http://localhost:3000/search?a=1&b=2&q=\\"x\\\\y\\"")
        def dummy = new com.intellij.testFramework.LightVirtualFile("localhost:3000")
        def previewFile = new com.intellij.ide.browsers.actions.WebPreviewVirtualFile(dummy, url)
        com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFile(previewFile, true)
    } catch (Throwable t) {
        t.printStackTrace()
    }
}
`

const GOLDEN_FRAG_DEFAULT = `if (!(com.intellij.openapi.util.registry.Registry.is("ide.web.preview.enabled") && com.intellij.openapi.util.registry.Registry.is("ide.browser.jcef.enabled"))) return
def url = com.intellij.util.Urls.newFromEncoded("http://h:1/x")
def dummy = new com.intellij.testFramework.LightVirtualFile("h:1")
def previewFile = new com.intellij.ide.browsers.actions.WebPreviewVirtualFile(dummy, url)
com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFile(previewFile, true)`

/** cwd baked into the setPreview goldens — selects the terminal's window in-IDE. */
const CWD = "/Users/me/proj"

// --- the launch/reap spy (runGroovy deps seam) ------------------------------

/** Capture the generated Groovy by injecting a launch spy that reads the temp. */
const captureDeps = (
    raises?: unknown
): {
    deps: RunGroovyDeps
    scripts: string[]
    calls: Array<{ args: string[]; wait: boolean }>
    reaped: string[][]
    warned: string[]
} => {
    const scripts: string[] = []
    const calls: Array<{ args: string[]; wait: boolean }> = []
    const reaped: string[][] = []
    const warned: string[] = []
    return {
        scripts,
        calls,
        reaped,
        warned,
        deps: {
            launch: async (args, options) => {
                calls.push({ args, wait: options?.wait ?? false })
                scripts.push(await Bun.file(args[1] ?? "").text())
                if (raises !== undefined) throw raises
                return {} as Bun.Subprocess
            },
            reapLater: (paths) => {
                const list = [...paths]
                reaped.push(list)
                for (const p of list) void Bun.file(p).unlink?.()
            },
            warn: (line) => warned.push(line)
        }
    }
}

describe("setPreview", () => {
    context("dispatching the rendered preview", () => {
        it("runs ideScript blocking", async () => {
            const cap = captureDeps()
            await setPreview("/Users/me/notes.md", CWD, cap.deps)

            expect(cap.calls.length).toBe(1)
            expect(cap.calls[0]?.wait).toBe(true)
            expect(cap.calls[0]?.args[0]).toBe("ideScript")
            expect(cap.calls[0]?.args[1]?.endsWith(".groovy")).toBe(true)
        })

        it("schedules the temp for reap exactly once (same path as ideScript)", async () => {
            const cap = captureDeps()
            await setPreview("/Users/me/notes.md", CWD, cap.deps)
            expect(cap.reaped).toEqual([[cap.calls[0]?.args[1] ?? ""]])
        })
    })

    context("the generated groovy", () => {
        it("GOLDEN: markdown route is byte-identical to the reference", async () => {
            const cap = captureDeps()
            await setPreview("/Users/me/notes.md", CWD, cap.deps)
            expect(cap.scripts[0]).toBe(GOLDEN_SETLAYOUT_MD)
        })

        it("GOLDEN: HTML route is byte-identical to the reference", async () => {
            const cap = captureDeps()
            await setPreview("/Users/me/page.html", CWD, cap.deps)
            expect(cap.scripts[0]).toBe(GOLDEN_WEBPREVIEW_HTML)
        })

        it("GOLDEN: escaped path (quote + backslash) is byte-identical to the reference", async () => {
            const cap = captureDeps()
            await setPreview('/tmp/we"ird\\name.md', CWD, cap.deps)
            expect(cap.scripts[0]).toBe(GOLDEN_SETLAYOUT_ESCAPED)
        })

        it("targets the project whose basePath is the longest prefix of cwd, fallback projects[0]", async () => {
            const cap = captureDeps()
            await setPreview("/Users/me/notes.md", "/Users/me/proj/pkg", cap.deps)
            const g = cap.scripts[0] ?? ""
            expect(g).toContain('def cwd = "/Users/me/proj/pkg"')
            expect(g).toContain("def project = projects[0]") // fallback when cwd matches none
            expect(g).toContain('cwd == bp || cwd.startsWith(bp + "/")')
            expect(g).toContain("bp.length() > bestLen")
        })

        it("escapes the cwd literal so a crafted path cannot break out of the string", async () => {
            const cap = captureDeps()
            await setPreview("/Users/me/notes.md", '/a"b\\c', cap.deps)
            const g = cap.scripts[0] ?? ""
            expect(g).toContain('def cwd = "/a\\"b\\\\c"')
            // the raw, unescaped cwd must never appear in the script
            expect(g).not.toContain('/a"b\\c')
        })

        it("non-HTML, non-previewable type still takes the setLayout route", async () => {
            const cap = captureDeps()
            await setPreview("/Users/me/snippet.ts", CWD, cap.deps)
            const g = cap.scripts[0] ?? ""
            expect(g).toContain("SHOW_PREVIEW")
            expect(g).toContain("TextEditorWithPreview")
            expect(g).not.toContain("WebPreviewVirtualFile")
        })

        it.each([
            "/Users/me/PAGE.HTML",
            "/Users/me/index.Htm",
            "/Users/me/doc.XhTmL"
        ])("HTML match is case-insensitive: %s", async (path) => {
            const cap = captureDeps()
            await setPreview(path, CWD, cap.deps)
            const g = cap.scripts[0] ?? ""
            expect(g).toContain("WebPreviewVirtualFile")
            expect(g).not.toContain("SHOW_PREVIEW")
        })
    })

    context("graceful degrade", () => {
        it.each([
            ["no-ide", "/Users/me/notes.md", new IdeaError("no JetBrains IDE in the process ancestry")],
            ["no-ide", "/Users/me/page.html", new IdeaError("no JetBrains IDE in the process ancestry")],
            [
                "unimplemented-platform",
                "/Users/me/notes.md",
                new NotImplementedError("resolveExecPath is not implemented for Linux yet")
            ],
            [
                "unimplemented-platform",
                "/Users/me/page.html",
                new NotImplementedError("resolveExecPath is not implemented for Linux yet")
            ],
            ["os-error", "/Users/me/notes.md", Object.assign(new Error("launcher missing"), { code: "ENOENT" })],
            ["os-error", "/Users/me/page.html", Object.assign(new Error("launcher missing"), { code: "ENOENT" })]
        ] as [string, string, unknown][])("degrades without throwing (%s, %s)", async (_id, path, err) => {
            const cap = captureDeps(err)
            await expect(setPreview(path, CWD, cap.deps)).resolves.toBeUndefined()
            expect(cap.warned.join("")).toContain("preview:")
            expect(cap.reaped.length).toBe(1)
        })
    })
})

describe("previewUrl", () => {
    context("dispatching the rendered preview", () => {
        it("runs ideScript blocking", async () => {
            const cap = captureDeps()
            await previewUrl("http://localhost:3000", undefined, CWD, cap.deps)
            expect(cap.calls.length).toBe(1)
            expect(cap.calls[0]?.wait).toBe(true)
            expect(cap.calls[0]?.args[0]).toBe("ideScript")
            expect(cap.calls[0]?.args[1]?.endsWith(".groovy")).toBe(true)
        })

        it("schedules the temp for reap exactly once", async () => {
            const cap = captureDeps()
            await previewUrl("http://localhost:3000", undefined, CWD, cap.deps)
            expect(cap.reaped).toEqual([[cap.calls[0]?.args[1] ?? ""]])
        })
    })

    context("the generated groovy", () => {
        it("GOLDEN: host:port default title is byte-identical to the reference", async () => {
            const cap = captureDeps()
            await previewUrl("http://localhost:3000", undefined, CWD, cap.deps)
            expect(cap.scripts[0]).toBe(GOLDEN_URL_HOSTPORT)
        })

        it("GOLDEN: query string + quote/backslash escaping is byte-identical to the reference", async () => {
            const cap = captureDeps()
            await previewUrl('http://localhost:3000/search?a=1&b=2&q="x\\y"', undefined, CWD, cap.deps)
            expect(cap.scripts[0]).toBe(GOLDEN_URL_QUERY_SPECIALS)
        })

        it("default title is host-only when no port", async () => {
            const cap = captureDeps()
            await previewUrl("https://example.com/docs", undefined, CWD, cap.deps)
            expect(cap.scripts[0]).toContain('new com.intellij.testFramework.LightVirtualFile("example.com")')
        })

        it("title falls back to the full URL when host can't be parsed", async () => {
            const cap = captureDeps()
            await previewUrl("http://", undefined, CWD, cap.deps)
            expect(cap.scripts[0]).toContain('new com.intellij.testFramework.LightVirtualFile("http://")')
        })

        it("title falls back to the raw url for a bare host:port (WHATWG reads it as a scheme, no host)", async () => {
            // `new URL("localhost:3000")` parses `localhost` as the protocol with an
            // empty host, so the host-less fallback must label the tab with the raw input.
            const cap = captureDeps()
            await previewUrl("localhost:3000", undefined, CWD, cap.deps)
            expect(cap.scripts[0]).toContain('new com.intellij.testFramework.LightVirtualFile("localhost:3000")')
        })

        it("title falls back to the raw url for invalid input (never throws)", async () => {
            const cap = captureDeps()
            await previewUrl("not a url", undefined, CWD, cap.deps)
            expect(cap.scripts[0]).toContain('new com.intellij.testFramework.LightVirtualFile("not a url")')
        })

        it("explicit title overrides the derived host:port", async () => {
            const cap = captureDeps()
            await previewUrl("http://localhost:3000", "My Dev Server", CWD, cap.deps)
            const g = cap.scripts[0] ?? ""
            expect(g).toContain('new com.intellij.testFramework.LightVirtualFile("My Dev Server")')
            // The derived label is NOT used (only the embedded URL mentions localhost:3000).
            expect(g.replaceAll("http://localhost:3000", "")).not.toContain("localhost:3000")
        })
    })

    context("graceful degrade", () => {
        it.each([
            ["no-ide", new IdeaError("no JetBrains IDE in the process ancestry")],
            ["unimplemented-platform", new NotImplementedError("resolveExecPath is not implemented for Linux yet")],
            ["os-error", Object.assign(new Error("launcher missing"), { code: "ENOENT" })]
        ] as [string, unknown][])("degrades without throwing (%s)", async (_id, err) => {
            const cap = captureDeps(err)
            await expect(previewUrl("http://localhost:3000", undefined, CWD, cap.deps)).resolves.toBeUndefined()
            expect(cap.warned.join("")).toContain("preview:")
            expect(cap.reaped.length).toBe(1)
        })
    })
})

describe("webpreviewOpenBody", () => {
    context("rendering the shared fragment", () => {
        it("GOLDEN: default (no indent, project var) is byte-identical to the reference", () => {
            expect(webpreviewOpenBody("http://h:1/x", "h:1")).toBe(GOLDEN_FRAG_DEFAULT)
        })

        it("indent prefixes every line", () => {
            const out = webpreviewOpenBody("http://h:1/x", "h:1", { indent: " ".repeat(8) })
            for (const line of out.split("\n")) {
                expect(line.startsWith("        ")).toBe(true)
            }
        })

        it("projectVar fills the getInstance(...) target", () => {
            const out = webpreviewOpenBody("http://h", "h", { projectVar: "proj" })
            expect(out).toContain("getInstance(proj)")
        })
    })
})
