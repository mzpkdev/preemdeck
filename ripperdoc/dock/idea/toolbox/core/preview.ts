/**
 * preview.ts — force the running JetBrains IDE to a rendered preview
 * (best-effort). Port of core/_preview.py.
 *
 * Opt-in companion to the open commands: after a file is open, switch its editor
 * to the right rendered preview — or, for `previewUrl`, open an arbitrary
 * http/https URL straight into the IDE's embedded JCEF web-preview tab. Driven
 * through `ideScript`: the IDE binary evaluates a Groovy script against the live
 * IntelliJ Platform API and forwards it to the running IDE (output lands in
 * idea.log).
 *
 * The path reaches Groovy by GENERATING a one-shot temp script with the target
 * embedded as a string literal. The script runs on the EDT and reopens the file
 * via FileEditorManager (which guarantees focus before the preview flip — no
 * racy sleep).
 *
 * Two routes, dispatched by the target's extension:
 *
 * - HTML-family (`HTML_PREVIEW_EXTS`): open the platform's JCEF web preview,
 *   gated behind the `ide.web.preview.enabled` / `ide.browser.jcef.enabled`
 *   registry keys; if either is off it no-ops.
 * - Everything else: flip the selected editor to SHOW_PREVIEW when it is a
 *   TextEditorWithPreview, so non-preview filetypes just no-op.
 *
 * `previewUrl` is the URL-native sibling: it skips the VFS lookup and wraps an
 * encoded URL in a `WebPreviewVirtualFile` backed by a throwaway
 * `LightVirtualFile` (tab titled "Preview of <title>"), routing it to the same
 * JCEF WebPreviewFileEditor.
 *
 * Both share one scaffolding path — `runGroovy`, the shared ideScript bridge:
 * generate a one-shot temp script, run it blocking, then hand the temp to
 * reapLater. `setPreview` is BEST-EFFORT — a missing live IDE / unavailable
 * ideScript / stub platform is swallowed with a short stderr note and it returns
 * without throwing, leaving the open intact. `previewUrl` shares that
 * never-throw scaffolding too, but open_url (no fallback) treats the stderr note
 * as a hard failure and exits non-zero.
 */

import { extname } from "node:path"
import { parseUrl } from "../../../../../lib/text.ts"
import { escapeGroovy, groovyProjectByCwd, type RunGroovyDeps, runGroovy } from "./groovy.ts"

/**
 * HTML-family extensions that route to the JCEF web preview instead of the
 * markdown SHOW_PREVIEW flip. Matched case-insensitively against the target's
 * suffix.
 */
export const HTML_PREVIEW_EXTS: ReadonlySet<string> = new Set([".html", ".htm", ".xhtml"])

/**
 * Groovy run on the EDT against the live IntelliJ Platform API. `path` and `cwd`
 * are already-escaped Groovy string literals. Reopening the file via
 * FileEditorManager.openFile(.., true) focuses it before the layout flip (no
 * sleep); the instanceof guard makes non-preview filetypes a clean no-op.
 *
 * Window targeting mirrors notify: reopen in the project whose basePath is the
 * longest prefix of `cwd` (the window the terminal sits in), falling back to the
 * first open project when `cwd` matches none — without it the preview lands in
 * whatever window getOpenProjects() returns first, not the terminal's.
 */
const groovySetLayout = (path: string, cwd: string): string => {
    return `import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.TextEditorWithPreview
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ide.DataManager

ApplicationManager.getApplication().invokeLater {
    def vFile = LocalFileSystem.getInstance().findFileByPath("${path}")
    if (vFile == null) return
    def projects = ProjectManager.getInstance().getOpenProjects()
    if (projects.length == 0) return
    def cwd = "${cwd}"
${groovyProjectByCwd({ indent: "    " })}
    def manager = FileEditorManager.getInstance(project)
    manager.openFile(vFile, true)
    def editor = manager.getSelectedEditor(vFile)
    if (editor instanceof TextEditorWithPreview) {
        editor.setLayout(TextEditorWithPreview.Layout.SHOW_PREVIEW)
    }
}
`
}

/**
 * Groovy for HTML-family targets: open the platform's JCEF web preview. `path`
 * is the target as an already-escaped Groovy string literal. Resolve the file's
 * URL via Urls.newFromVirtualFile, wrap it in a WebPreviewVirtualFile, and open
 * that. Gated on the web-preview + JCEF registry keys; if either is off it
 * no-ops (the file is already open from the prior launch).
 */
const groovyWebPreview = (path: string, cwd: string): string => {
    return `import com.intellij.openapi.application.ApplicationManager
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
        def cwd = "${cwd}"
${groovyProjectByCwd({ indent: "        " })}
        def vFile = LocalFileSystem.getInstance().refreshAndFindFileByPath("${path}")
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
}

/**
 * The proven WebPreview-open OPERATION, the SINGLE SOURCE OF TRUTH so every
 * caller that opens a URL in the JCEF web-preview tab composes the same Groovy
 * and can't drift. Both `groovyUrlPreview` below and notify's `open-preview`
 * action build on this fragment — see `webpreviewOpenBody`.
 *
 * A self-contained statement block (NOT a full script): it assumes a `project`
 * variable is already in scope and uses fully-qualified class names so it needs
 * no imports, letting it drop verbatim into either a top-level script body or a
 * closure body. `url`/`title` are already-escaped Groovy string literals; the
 * registry gate no-ops in-IDE if either key is off; the URL is encoded via
 * Urls.newFromEncoded and wrapped in a WebPreviewVirtualFile backed by a
 * throwaway LightVirtualFile named `title` (so the tab reads "Preview of
 * <title>"). No VFS lookup (the dummy stands in).
 *
 * NOTE: line 1 is intentionally one physical line — the two Registry.is(...)
 * calls are joined (the original source used `\` line-continuations), and the
 * block has NO trailing newline. Both are load-bearing for byte-parity.
 */
const webpreviewOpenBodyRaw = (url: string, title: string, projectVar: string): string => {
    return `if (!(com.intellij.openapi.util.registry.Registry.is("ide.web.preview.enabled") && com.intellij.openapi.util.registry.Registry.is("ide.browser.jcef.enabled"))) return
def url = com.intellij.util.Urls.newFromEncoded("${url}")
def dummy = new com.intellij.testFramework.LightVirtualFile("${title}")
def previewFile = new com.intellij.ide.browsers.actions.WebPreviewVirtualFile(dummy, url)
com.intellij.openapi.fileEditor.FileEditorManager.getInstance(${projectVar}).openFile(previewFile, true)`
}

/**
 * Splice controls for {@link webpreviewOpenBody}: which in-scope Project the
 * open binds to, and the indent to align the fragment when it drops into a
 * deeper nesting level. Both default so a top-level script body needs neither.
 */
export type WebpreviewOpenBodyOptions = {
    /**
     * Name of the in-scope Project the open targets. Defaults to `project` (the
     * script path's local), but a closure nested inside a scope that already binds
     * `project` (notify's action) must pass a non-colliding name, since Groovy
     * forbids re-declaring an enclosing-scope variable.
     */
    projectVar?: string
    /** Prefixed to every line so the block aligns when spliced into a deeper nesting level. */
    indent?: string
}

/**
 * Render the shared WebPreview-open fragment with `url`/`title` literals.
 *
 * The single source of truth for opening a URL in the IDE's JCEF web-preview tab
 * — both `groovyUrlPreview` and notify's `open-preview` action compose this, so
 * the proven mechanism can't drift between them. `urlLiteral` and `titleLiteral`
 * must already be escaped Groovy string literals (the caller runs them through
 * `escapeGroovy`).
 */
export const webpreviewOpenBody = (
    urlLiteral: string,
    titleLiteral: string,
    options: WebpreviewOpenBodyOptions = {}
): string => {
    const projectVar = options.projectVar ?? "project"
    const indent = options.indent ?? ""
    const body = webpreviewOpenBodyRaw(urlLiteral, titleLiteral, projectVar)
    if (indent === "") {
        return body
    }
    return body
        .split("\n")
        .map((line) => indent + line)
        .join("\n")
}

/**
 * Groovy for an arbitrary http/https URL: open it straight into the IDE's
 * embedded JCEF web-preview tab. `body` is the shared WebPreview-open fragment
 * (see `webpreviewOpenBody`); `cwd` is an already-escaped Groovy literal. The
 * wrapper here is the script-specific part: run on the EDT, pick the terminal's
 * window (longest basePath prefix of `cwd`, fallback first project), and guard
 * the whole body so a stray throwable lands in idea.log rather than escaping the
 * ideScript run.
 */
const groovyUrlPreview = (body: string, cwd: string): string => {
    return `import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.ProjectManager

ApplicationManager.getApplication().invokeLater {
    try {
        def projects = ProjectManager.getInstance().getOpenProjects()
        if (projects.length == 0) return
        def cwd = "${cwd}"
${groovyProjectByCwd({ indent: "        " })}
${body}
    } catch (Throwable t) {
        t.printStackTrace()
    }
}
`
}

/**
 * Derive a clean tab label from `url`: its host with `:port` when present, e.g.
 * `http://localhost:3000/x?y=1` -> `localhost:3000`. Falls back to the full URL
 * string when the host can't be parsed (e.g. a scheme-only input), so the tab
 * always gets a non-empty label.
 */
const titleFor = (url: string): string => {
    const parts = parseUrl(url)
    if (parts.hostname) {
        return parts.port !== null ? `${parts.hostname}:${parts.port}` : parts.hostname
    }
    return url
}

/**
 * Render the preview Groovy with `path` and `cwd` embedded as safe string
 * literals.
 *
 * Dispatches by extension: HTML-family targets (`HTML_PREVIEW_EXTS`, matched
 * case-insensitively) get the JCEF web-preview Groovy; everything else gets the
 * markdown SHOW_PREVIEW flip. Both route the open to the project whose basePath
 * is the longest prefix of `cwd` (the terminal's window).
 */
const groovyFor = (path: string, cwd: string): string => {
    const literal = escapeGroovy(path)
    const cwdLiteral = escapeGroovy(cwd)
    const ext = extname(path).toLowerCase()
    return HTML_PREVIEW_EXTS.has(ext) ? groovyWebPreview(literal, cwdLiteral) : groovySetLayout(literal, cwdLiteral)
}

/**
 * Best-effort: switch the open editor for `path` to its rendered preview.
 *
 * Generates a one-shot Groovy with `path` injected — the JCEF web preview for
 * HTML-family targets, the SHOW_PREVIEW flip otherwise — and runs it through the
 * shared `runGroovy` scaffolding (blocking ideScript run + deferred reap).
 *
 * NEVER throws: a missing live IDE (IdeaError), an unimplemented platform
 * (NotImplementedError), or any OS error spawning the launcher is swallowed with
 * a short stderr note, so the caller's open is never turned into a failure.
 * Non-preview filetypes are a clean no-op (guarded inside the Groovy).
 *
 * `cwd` picks the target window — the open project whose basePath is the longest
 * prefix of it (the window the terminal sits in); empty (the default) leaves the
 * open in the first project, matching the pre-targeting behavior. `deps` is
 * forwarded to runGroovy for hermetic tests.
 */
export const setPreview = async (path: string, cwd = "", deps: RunGroovyDeps = {}): Promise<void> => {
    await runGroovy(groovyFor(path, cwd), "preview: could not set preview", deps)
}

/**
 * Open `url` in the running IDE's embedded JCEF web-preview tab (best-effort).
 *
 * Renders the URL Groovy with `url` and a tab `title` injected (both escaped as
 * Groovy string literals) and runs it through the shared `runGroovy`
 * scaffolding. The platform opens a WebPreviewVirtualFile over the encoded URL,
 * landing it in a WebPreviewFileEditor / JCEF tab titled "Preview of <title>".
 *
 * `title` defaults to a clean label derived from the URL (its host[:port]),
 * falling back to the full URL when the host can't be parsed.
 *
 * Like setPreview, NEVER throws: no live IDE / stub platform / spawn failure is
 * swallowed with a stderr note. Unlike setPreview there is no in-IDE fallback,
 * so the open_url CLI turns that note into a non-zero exit.
 *
 * `cwd` picks the target window (longest basePath prefix); empty (the default)
 * leaves the open in the first project, matching the pre-targeting behavior.
 */
export const previewUrl = async (url: string, title?: string, cwd = "", deps: RunGroovyDeps = {}): Promise<void> => {
    const label = title !== undefined ? title : titleFor(url)
    // The open itself is the shared fragment (parity with notify's open-preview);
    // this script only adds the EDT + window-targeting + throwable-guard wrapper.
    // The body sits two levels deep (invokeLater + try), so indent it to 8 spaces.
    const body = webpreviewOpenBody(escapeGroovy(url), escapeGroovy(label), { indent: " ".repeat(8) })
    await runGroovy(groovyUrlPreview(body, escapeGroovy(cwd)), "preview: could not open URL preview", deps)
}
