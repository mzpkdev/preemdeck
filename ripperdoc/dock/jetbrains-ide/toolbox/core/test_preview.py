"""Tests for core._preview — hermetic: no real IDE, no ideScript, no polling.

set_preview() drives a rendered preview through an ideScript run, dispatching by
the target's extension: HTML-family files (.html/.htm/.xhtml) get the JCEF web
preview (WebPreviewVirtualFile + openFile, behind a registry gate); everything
else gets the markdown SHOW_PREVIEW flip. Like test_reap mocks the reaper's
sleep, here the IDE-facing seams are mocked: `launch` on the _preview module is a
recording stub (spawns nothing) and `reap_later` is a spy. That lets the tests
assert what set_preview would have fired — the spawned argv (`["ideScript",
<script>]`, wait=True), the Groovy injected into the temp (path embedded, the
route-correct API present), and the deferred reap — plus the graceful-degrade
contract: a missing IDE / unimplemented platform / OS error is swallowed with a
stderr note, never raised, so the caller's open stands.
"""

import threading
from pathlib import Path

import pytest

from core import JetBrainsError, _preview, _reap, preview_url, set_preview


class _LaunchSpy:
    """A launch() stub: records argv + wait, reads the temp script back, spawns
    nothing. The script is read at call time, before set_preview's reap runs."""

    def __init__(self, *, raises: BaseException | None = None) -> None:
        self.calls: list[dict[str, object]] = []
        self.scripts: list[str] = []
        self._raises = raises

    def __call__(self, args: list[str], *, wait: bool = False) -> object:
        self.calls.append({"args": args, "wait": wait})
        # args is ["ideScript", <script path>]: capture the generated Groovy now.
        self.scripts.append(Path(args[-1]).read_text())
        if self._raises is not None:
            raise self._raises
        return object()


def _install(monkeypatch: pytest.MonkeyPatch, spy: _LaunchSpy) -> list[list[str]]:
    """Wire the launch spy and a reap_later spy onto _preview; return reap log.

    The spy records the scheduled paths AND unlinks them immediately (what the
    real reaper does, minus the delay) — so the test both asserts the reap
    contract and leaves no temp behind."""
    monkeypatch.setattr(_preview, "launch", spy)
    reaped: list[list[str]] = []

    def reap(paths: list[str]) -> None:
        paths = list(paths)
        reaped.append(paths)
        for path in paths:
            Path(path).unlink(missing_ok=True)

    monkeypatch.setattr(_preview, "reap_later", reap)
    return reaped


# --- the happy path: fires ideScript, injects the path, reaps the temp -------


def test_set_preview_runs_idescript_blocking(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    set_preview("/Users/me/notes.md")

    # Exactly one ideScript run, blocking (wait=True) so the IDE evaluates it.
    assert len(spy.calls) == 1
    call = spy.calls[0]
    assert call["wait"] is True
    args = call["args"]
    assert args[0] == "ideScript"
    assert args[1].endswith(".groovy")


def test_set_preview_injects_path_and_show_preview(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    set_preview("/Users/me/notes.md")

    groovy = spy.scripts[0]
    # The target path is embedded as a literal the script resolves via VFS.
    assert "/Users/me/notes.md" in groovy
    assert "findFileByPath" in groovy
    # The layout flip and the guard that keeps non-preview filetypes a no-op.
    assert "SHOW_PREVIEW" in groovy
    assert "instanceof" in groovy
    assert "TextEditorWithPreview" in groovy
    # Markdown does NOT take the web-preview route.
    assert "WebPreviewVirtualFile" not in groovy


# --- dispatch by extension: HTML-family -> web preview, else -> setLayout -----


def test_set_preview_html_uses_web_preview_groovy(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    set_preview("/Users/me/page.html")

    groovy = spy.scripts[0]
    # The web-preview route: wrap the file's URL in a WebPreviewVirtualFile and
    # open THAT (the platform routes it to WebPreviewFileEditor / JCEF).
    assert "/Users/me/page.html" in groovy
    assert "WebPreviewVirtualFile" in groovy
    assert "Urls.newFromVirtualFile" in groovy
    assert "openFile" in groovy
    # Gated behind the web-preview + JCEF registry keys.
    assert 'Registry.is("ide.web.preview.enabled")' in groovy
    assert 'Registry.is("ide.browser.jcef.enabled")' in groovy
    # It must NOT be the markdown setLayout route.
    assert "SHOW_PREVIEW" not in groovy
    assert "TextEditorWithPreview" not in groovy


def test_set_preview_non_html_uses_setlayout_groovy(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    # A non-HTML, non-previewable type still takes the existing setLayout route
    # (the in-Groovy instanceof guard makes it a clean no-op at runtime).
    set_preview("/Users/me/snippet.py")

    groovy = spy.scripts[0]
    assert "SHOW_PREVIEW" in groovy
    assert "TextEditorWithPreview" in groovy
    assert "WebPreviewVirtualFile" not in groovy


@pytest.mark.parametrize(
    "path",
    ["/Users/me/PAGE.HTML", "/Users/me/index.Htm", "/Users/me/doc.XhTmL"],
    ids=["upper-html", "mixed-htm", "mixed-xhtml"],
)
def test_set_preview_html_match_is_case_insensitive(monkeypatch: pytest.MonkeyPatch, path: str) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    set_preview(path)

    groovy = spy.scripts[0]
    # Suffix matching is case-insensitive: an upper/mixed-case HTML-family
    # extension still routes to the web preview, not the markdown flip.
    assert "WebPreviewVirtualFile" in groovy
    assert "SHOW_PREVIEW" not in groovy


def test_set_preview_escapes_path_with_quotes_and_backslashes(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    # A path with a quote and a backslash must land as an escaped Groovy literal,
    # not break out of the string (which would be a malformed script).
    set_preview('/tmp/we"ird\\name.md')

    groovy = spy.scripts[0]
    assert '/tmp/we\\"ird\\\\name.md' in groovy


def test_set_preview_schedules_temp_for_reap(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    reaped = _install(monkeypatch, spy)

    set_preview("/Users/me/notes.md")

    # The one-shot script is handed to the deferred reaper exactly once. It is the
    # same path that was passed to ideScript.
    script = spy.calls[0]["args"][1]
    assert reaped == [[script]]


def test_set_preview_temp_is_gone_after_real_reap(monkeypatch: pytest.MonkeyPatch) -> None:
    # With reap_later left REAL but its sleep neutered, the generated temp is
    # actually unlinked — set_preview leaks nothing on disk.
    monkeypatch.setattr(_preview, "launch", _LaunchSpy())
    # Neuter the reaper's wall-clock sleep so its unlink runs immediately.
    monkeypatch.setattr(_reap.time, "sleep", lambda _s: None)

    created: list[str] = []
    real_mkstemp = _preview.tempfile.mkstemp

    def tracking_mkstemp(*a: object, **k: object) -> tuple[int, str]:
        fd, path = real_mkstemp(*a, **k)
        created.append(path)
        return fd, path

    monkeypatch.setattr(_preview.tempfile, "mkstemp", tracking_mkstemp)

    before = set(threading.enumerate())
    set_preview("/Users/me/notes.md")
    # Join the reaper thread set_preview spawned so its unlink has run.
    for thread in [t for t in threading.enumerate() if t not in before]:
        thread.join(timeout=5)

    assert created and not Path(created[0]).exists()


# --- graceful degrade: never raise, note on stderr, open still stands --------


@pytest.mark.parametrize(
    "exc",
    [
        JetBrainsError("no JetBrains IDE in the process ancestry"),
        NotImplementedError("resolve_exec_path is not implemented for Linux yet"),
        OSError("launcher missing"),
    ],
    ids=["no-ide", "unimplemented-platform", "os-error"],
)
@pytest.mark.parametrize("path", ["/Users/me/notes.md", "/Users/me/page.html"], ids=["md-branch", "html-branch"])
def test_set_preview_degrades_without_raising(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], exc: BaseException, path: str
) -> None:
    spy = _LaunchSpy(raises=exc)
    reaped = _install(monkeypatch, spy)

    # No live IDE / stub platform / spawn failure: set_preview swallows it and
    # returns. The caller's open is never turned into a failure. Holds for BOTH
    # routes — the degrade is in set_preview, downstream of the branch choice.
    assert set_preview(path) is None

    err = capsys.readouterr().err
    assert "preview:" in err  # a short note explaining preview couldn't be set
    # Even on the degrade path the temp script is still scheduled for cleanup.
    assert len(reaped) == 1


# --- preview_url: open an arbitrary http/https URL in the JCEF preview tab -----


def test_preview_url_runs_idescript_blocking(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    preview_url("http://localhost:3000")

    # Shares set_preview's scaffolding: exactly one blocking ideScript run.
    assert len(spy.calls) == 1
    call = spy.calls[0]
    assert call["wait"] is True
    assert call["args"][0] == "ideScript"
    assert call["args"][1].endswith(".groovy")


def test_preview_url_injects_url_and_web_preview(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    preview_url("http://localhost:3000")

    groovy = spy.scripts[0]
    # The URL is embedded and opened via the WebPreviewVirtualFile/JCEF route.
    assert "http://localhost:3000" in groovy
    assert "WebPreviewVirtualFile" in groovy
    assert "Urls.newFromEncoded" in groovy
    assert "openFile" in groovy
    # A throwaway LightVirtualFile stands in for the dummy original file.
    assert "LightVirtualFile" in groovy
    # Gated behind the web-preview + JCEF registry keys.
    assert 'Registry.is("ide.web.preview.enabled")' in groovy
    assert 'Registry.is("ide.browser.jcef.enabled")' in groovy
    # It is the URL route, not the file routes.
    assert "SHOW_PREVIEW" not in groovy
    assert "findFileByPath" not in groovy
    assert "refreshAndFindFileByPath" not in groovy


def test_preview_url_default_title_is_host_port(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    preview_url("http://localhost:3000/some/path?x=1")

    groovy = spy.scripts[0]
    # The tab title defaults to host:port — the platform shows "Preview of <title>".
    assert 'new LightVirtualFile("localhost:3000")' in groovy


def test_preview_url_default_title_host_only_when_no_port(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    preview_url("https://example.com/docs")

    groovy = spy.scripts[0]
    # No explicit port -> bare host (no trailing colon).
    assert 'new LightVirtualFile("example.com")' in groovy


def test_preview_url_title_falls_back_to_full_url(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    # A scheme-only input has no host: the title falls back to the whole URL so
    # the tab still gets a non-empty label.
    preview_url("http://")

    groovy = spy.scripts[0]
    assert 'new LightVirtualFile("http://")' in groovy


def test_preview_url_explicit_title_overrides_derivation(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    preview_url("http://localhost:3000", title="My Dev Server")

    groovy = spy.scripts[0]
    assert 'new LightVirtualFile("My Dev Server")' in groovy
    # The derived host:port label is NOT used when a title is passed.
    assert "localhost:3000" not in groovy.replace("http://localhost:3000", "")


def test_preview_url_escapes_query_string_and_specials(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    # A URL with a query string and a quote/backslash must land as an escaped
    # Groovy literal, not break out of the string (a malformed script).
    preview_url('http://localhost:3000/search?a=1&b=2&q="x\\y"')

    groovy = spy.scripts[0]
    # The ampersands survive verbatim and the quote/backslash are escaped.
    assert 'Urls.newFromEncoded("http://localhost:3000/search?a=1&b=2&q=\\"x\\\\y\\"")' in groovy


def test_preview_url_schedules_temp_for_reap(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    reaped = _install(monkeypatch, spy)

    preview_url("http://localhost:3000")

    # The one-shot script is handed to the deferred reaper exactly once — the
    # same path that was passed to ideScript (shared _run_groovy scaffolding).
    script = spy.calls[0]["args"][1]
    assert reaped == [[script]]


@pytest.mark.parametrize(
    "exc",
    [
        JetBrainsError("no JetBrains IDE in the process ancestry"),
        NotImplementedError("resolve_exec_path is not implemented for Linux yet"),
        OSError("launcher missing"),
    ],
    ids=["no-ide", "unimplemented-platform", "os-error"],
)
def test_preview_url_degrades_without_raising(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], exc: BaseException
) -> None:
    spy = _LaunchSpy(raises=exc)
    reaped = _install(monkeypatch, spy)

    # No live IDE / stub platform / spawn failure: like set_preview, preview_url
    # swallows it and returns None (never raises). The CLI boundary (open_url) is
    # what turns this note into a non-zero exit.
    assert preview_url("http://localhost:3000") is None

    err = capsys.readouterr().err
    assert "preview:" in err
    # Even on the degrade path the temp script is still scheduled for cleanup.
    assert len(reaped) == 1
