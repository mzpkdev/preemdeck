"""Force the running JetBrains IDE to a rendered preview (best-effort).

Opt-in companion to the open commands: after a file is open, switch its editor to
the right rendered preview — or, for `preview_url`, open an arbitrary http/https
URL straight into the IDE's embedded JCEF web-preview tab. This is driven through
`ideScript` — the IDE binary evaluates a Groovy script against the live IntelliJ
Platform API and forwards it to the running IDE (its output lands in idea.log).

The path reaches Groovy by GENERATING a one-shot temp script with the target
embedded as a string literal (no reliance on `ideScript` arg binding, which the
launcher does not surface to the script). The script runs on the EDT and reopens
the file via FileEditorManager (which guarantees focus before the preview flip —
no racy sleep).

Two routes, dispatched in Python by the target's extension:

- HTML-family (`HTML_PREVIEW_EXTS`): open the platform's JCEF web preview. The
  Groovy resolves the file's URL via `Urls.newFromVirtualFile`, wraps it in a
  `WebPreviewVirtualFile`, and opens that — the platform routes it to
  `WebPreviewFileEditor`. Gated behind the `ide.web.preview.enabled` /
  `ide.browser.jcef.enabled` registry keys; if either is off it no-ops (the file
  is already open from the prior launch).
- Everything else (.md/.mdx and any non-HTML type): flip the selected editor to
  SHOW_PREVIEW when it is a TextEditorWithPreview, so non-preview filetypes just
  no-op.

`preview_url` is the URL-native sibling: it skips the VFS lookup and wraps an
encoded URL in a `WebPreviewVirtualFile` backed by a throwaway LightVirtualFile
(the tab is titled "Preview of <title>"), routing it to the same JCEF
WebPreviewFileEditor. Same registry gate; same EDT run.

Both entry points share one scaffolding path — `run_groovy`, the shared
ideScript bridge from `_groovy`: generate a one-shot temp script, run it via
`launch(["ideScript", script], wait=True)`, then hand the temp to reap_later for a
deferred unlink (the toolbox's fire-and-forget cleanup idiom). `set_preview` is
BEST-EFFORT — preview is a nicety layered on the open, never a gate — so a missing
live IDE / unavailable ideScript / stub platform is
swallowed with a short stderr note and it returns without raising, leaving the
open intact. `preview_url` shares that never-raise scaffolding too, but callers
that have nothing else to fall back on (open_url) treat the stderr note as a hard
failure and exit non-zero.
"""

from pathlib import Path
from urllib.parse import urlsplit

from ._groovy import escape_groovy, run_groovy

# HTML-family extensions that route to the JCEF web preview instead of the
# markdown SHOW_PREVIEW flip. Named so adding ".svg" etc. later is a one-line
# change; matched case-insensitively against the target's suffix.
HTML_PREVIEW_EXTS = {".html", ".htm", ".xhtml"}

# Groovy run on the EDT against the live IntelliJ Platform API. {path} is filled
# with the target as an escaped Groovy string literal. Reopening the file via
# FileEditorManager.openFile(.., true) focuses it before the layout flip (no
# sleep); the instanceof guard makes non-preview filetypes a clean no-op.
_GROOVY_SETLAYOUT = """\
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.TextEditorWithPreview
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ide.DataManager

ApplicationManager.getApplication().invokeLater {{
    def vFile = LocalFileSystem.getInstance().findFileByPath("{path}")
    if (vFile == null) return
    def projects = ProjectManager.getInstance().getOpenProjects()
    if (projects.length == 0) return
    def project = projects[0]
    def manager = FileEditorManager.getInstance(project)
    manager.openFile(vFile, true)
    def editor = manager.getSelectedEditor(vFile)
    if (editor instanceof TextEditorWithPreview) {{
        editor.setLayout(TextEditorWithPreview.Layout.SHOW_PREVIEW)
    }}
}}
"""

# Groovy for HTML-family targets: open the platform's JCEF web preview. {path} is
# filled with the target as an escaped Groovy string literal. The proven handle
# from the live probe: resolve the file's URL via Urls.newFromVirtualFile (the
# WebBrowserService.getUrlsToOpen(boolean, VirtualFile) overload does NOT exist),
# wrap it in a WebPreviewVirtualFile, and open that — the platform routes it to
# WebPreviewFileEditor. Gated on the web-preview + JCEF registry keys; if either
# is off it no-ops (the file is already open from the prior launch).
_GROOVY_WEBPREVIEW = """\
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.util.registry.Registry
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.util.Urls
import com.intellij.ide.browsers.actions.WebPreviewVirtualFile

ApplicationManager.getApplication().invokeLater {{
    try {{
        def projects = ProjectManager.getInstance().getOpenProjects()
        if (projects.length == 0) return
        def project = projects[0]
        def vFile = LocalFileSystem.getInstance().refreshAndFindFileByPath("{path}")
        if (vFile == null) return
        if (!(Registry.is("ide.web.preview.enabled") && Registry.is("ide.browser.jcef.enabled"))) return
        def url = Urls.newFromVirtualFile(vFile)
        def previewFile = new WebPreviewVirtualFile(vFile, url)
        FileEditorManager.getInstance(project).openFile(previewFile, true)
    }} catch (Throwable t) {{
        t.printStackTrace()
    }}
}}
"""

# The proven WebPreview-open OPERATION, factored out as a SINGLE SOURCE OF TRUTH
# so every caller that opens a URL in the JCEF web-preview tab composes the same
# Groovy and can't drift. Both `_GROOVY_URLPREVIEW` below and notify.py's
# `open-preview` action build on this fragment — see `webpreview_open_body`.
#
# A self-contained statement block (NOT a full script): it assumes a `project`
# variable is already in scope and uses fully-qualified class names so it needs no
# imports, letting it drop verbatim into either a top-level script body or a
# closure body. {url} and {title} are filled as escaped Groovy string literals.
# The handle from the live probe: gate on the web-preview + JCEF registry keys
# (no-op in-IDE if either is off), encode the URL via Urls.newFromEncoded, wrap it
# in a WebPreviewVirtualFile backed by a throwaway LightVirtualFile named {title}
# (so the tab reads "Preview of {title}"), and open that — the platform routes it
# to WebPreviewFileEditor / JCEF. No VFS lookup (the dummy stands in) and no
# CUSTOM_ORIGINAL_FILE needed.
_WEBPREVIEW_OPEN_BODY = """\
if (!(com.intellij.openapi.util.registry.Registry.is("ide.web.preview.enabled") \
&& com.intellij.openapi.util.registry.Registry.is("ide.browser.jcef.enabled"))) return
def url = com.intellij.util.Urls.newFromEncoded("{url}")
def dummy = new com.intellij.testFramework.LightVirtualFile("{title}")
def previewFile = new com.intellij.ide.browsers.actions.WebPreviewVirtualFile(dummy, url)
com.intellij.openapi.fileEditor.FileEditorManager.getInstance({project}).openFile(previewFile, true)\
"""


def webpreview_open_body(
    url_literal: str, title_literal: str, *, project_var: str = "project", indent: str = ""
) -> str:
    """Render the shared WebPreview-open fragment with `url`/`title` literals.

    The single source of truth for opening a URL in the IDE's JCEF web-preview
    tab — both `_GROOVY_URLPREVIEW` and notify.py's `open-preview` action compose
    this, so the proven mechanism can't drift between them. `url_literal` and
    `title_literal` must already be escaped Groovy string literals (the caller
    runs them through `escape_groovy`).

    `project_var` is the name of the in-scope Project the open targets — it
    defaults to `project` (the script path's local), but a closure nested inside a
    scope that already binds `project` (notify's action) must pass a non-colliding
    name, since Groovy forbids re-declaring an enclosing-scope variable. `indent`
    is prefixed to every line so the block aligns when spliced into a deeper
    nesting level (a script's invokeLater vs. a closure).
    """
    body = _WEBPREVIEW_OPEN_BODY.format(url=url_literal, title=title_literal, project=project_var)
    if not indent:
        return body
    return "\n".join(indent + line for line in body.splitlines())


# Groovy for an arbitrary http/https URL: open it straight into the IDE's
# embedded JCEF web-preview tab. {body} is filled with the shared WebPreview-open
# fragment (see `_WEBPREVIEW_OPEN_BODY` / `webpreview_open_body`) — the single
# source of truth for the open, so this script and notify's `open-preview` action
# never diverge. The wrapper here is the script-specific part: run on the EDT, grab
# the first open project, and guard the whole body so a stray throwable lands in
# idea.log rather than escaping the ideScript run.
_GROOVY_URLPREVIEW = """\
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.ProjectManager

ApplicationManager.getApplication().invokeLater {{
    try {{
        def projects = ProjectManager.getInstance().getOpenProjects()
        if (projects.length == 0) return
        def project = projects[0]
{body}
    }} catch (Throwable t) {{
        t.printStackTrace()
    }}
}}
"""


def _title_for(url: str) -> str:
    """Derive a clean tab label from `url`: its host with `:port` when present.

    e.g. `http://localhost:3000/x?y=1` -> `localhost:3000`. Falls back to the
    full URL string when the host can't be parsed (e.g. a scheme-only input),
    so the tab always gets a non-empty label.
    """
    parts = urlsplit(url)
    if parts.hostname:
        return f"{parts.hostname}:{parts.port}" if parts.port else parts.hostname
    return url


def _groovy_for(path: str) -> str:
    """Render the preview Groovy with `path` embedded as a safe string literal.

    Dispatches by extension: HTML-family targets (`HTML_PREVIEW_EXTS`, matched
    case-insensitively) get the JCEF web-preview Groovy; everything else gets the
    markdown SHOW_PREVIEW flip.
    """
    literal = escape_groovy(path)
    ext = Path(path).suffix.lower()
    template = _GROOVY_WEBPREVIEW if ext in HTML_PREVIEW_EXTS else _GROOVY_SETLAYOUT
    return template.format(path=literal)


def set_preview(path: str) -> None:
    """Best-effort: switch the open editor for `path` to its rendered preview.

    Generates a one-shot Groovy with `path` injected — the JCEF web preview for
    HTML-family targets, the SHOW_PREVIEW flip otherwise — and runs it through
    the shared `run_groovy` scaffolding (blocking ideScript run + deferred reap).

    NEVER raises: a missing live IDE (IdeaError), an unimplemented platform
    (NotImplementedError), or any OS error spawning the launcher is swallowed
    with a short stderr note, so the caller's open is never turned into a
    failure. Non-preview filetypes are a clean no-op (guarded inside the Groovy).
    """
    run_groovy(_groovy_for(path), note="preview: could not set preview")


def preview_url(url: str, title: str | None = None) -> None:
    """Open `url` in the running IDE's embedded JCEF web-preview tab (best-effort).

    Renders the URL Groovy with `url` and a tab `title` injected (both escaped as
    Groovy string literals) and runs it through the shared `run_groovy`
    scaffolding. The platform opens a WebPreviewVirtualFile over the encoded URL,
    landing it in a WebPreviewFileEditor / JCEF tab titled "Preview of <title>".

    `title` defaults to a clean label derived from the URL (its host[:port], e.g.
    `localhost:3000`), falling back to the full URL when the host can't be parsed.

    Like set_preview, NEVER raises: no live IDE / stub platform / spawn failure is
    swallowed with a stderr note. Unlike set_preview there is no in-IDE fallback,
    so the open_url CLI turns that note into a non-zero exit. The in-IDE registry
    gate (web-preview + JCEF) handles the JCEF-off case as a clean no-op.
    """
    label = title if title is not None else _title_for(url)
    # The open itself is the shared fragment (parity with notify's open-preview);
    # this script only adds the EDT + project-fetch + throwable-guard wrapper. The
    # body sits two levels deep (invokeLater + try), so indent it to 8 spaces.
    body = webpreview_open_body(escape_groovy(url), escape_groovy(label), indent=" " * 8)
    groovy = _GROOVY_URLPREVIEW.format(body=body)
    run_groovy(groovy, note="preview: could not open URL preview")
