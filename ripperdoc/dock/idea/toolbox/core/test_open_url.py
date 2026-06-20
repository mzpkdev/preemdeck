"""Tests for open_url — hermetic: no real IDE, no ideScript, no subprocess.

open_url opens an http/https URL in the running IDE's embedded JCEF preview. The
two IDE seams are monkeypatched on the module: `resolve_exec_path` (the single
live-IDE guard, mirroring open_file's launch guard) is a stub that either returns
a fake binary or raises, and `preview_url` is a recorder that captures the
(url, title) it would fire — spawning nothing.

The contract: validate an http/https URL (else exit 1 with a clear note, no
shell-out to a browser), confirm a live IDE via resolve_exec_path (an IdeaError
/ NotImplementedError surfaces as exit 1 — there is no external-browser fallback),
then delegate to preview_url. There is no --wait (URL preview is fire-and-forget).
"""

import open_url
import pytest
from open_url import open_url as open_url_fn

from core import IdeaError


@pytest.fixture(autouse=True)
def _in_idea(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default the CLI's in_idea() gate to True so main() tests are hermetic.

    main() now fails fast outside a JetBrains terminal; without this the suite
    would depend on the ambient shell. Gate-firing is covered explicitly below.
    """
    monkeypatch.setattr(open_url, "in_idea", lambda: True)


def _stub_seams(
    monkeypatch: pytest.MonkeyPatch, *, resolve_raises: BaseException | None = None
) -> list[dict[str, object]]:
    """Wire fake resolve_exec_path + preview_url onto open_url; return preview log.

    resolve_exec_path stands in for the live-IDE guard (returns a fake binary, or
    raises `resolve_raises` for the no-IDE / stub-platform cases). preview_url is
    a recorder capturing the (url, title) it would have fired — nothing spawns."""
    previewed: list[dict[str, object]] = []

    def resolve() -> str:
        if resolve_raises is not None:
            raise resolve_raises
        return "/Applications/WebStorm.app/Contents/MacOS/webstorm"

    def preview(url: str, title: str | None = None) -> None:
        previewed.append({"url": url, "title": title})

    monkeypatch.setattr(open_url, "resolve_exec_path", resolve)
    monkeypatch.setattr(open_url, "preview_url", preview)
    return previewed


# --- open_url(): live-IDE guard then delegate to preview_url ----------------


def test_open_url_delegates_to_preview_url(monkeypatch: pytest.MonkeyPatch) -> None:
    previewed = _stub_seams(monkeypatch)

    # A live IDE confirmed: the URL (and default title=None) reach preview_url.
    assert open_url_fn("http://localhost:3000") is None
    assert previewed == [{"url": "http://localhost:3000", "title": None}]


def test_open_url_threads_explicit_title(monkeypatch: pytest.MonkeyPatch) -> None:
    previewed = _stub_seams(monkeypatch)

    assert open_url_fn("https://example.com", "docs") is None
    assert previewed == [{"url": "https://example.com", "title": "docs"}]


def test_open_url_resolve_guard_runs_before_preview(monkeypatch: pytest.MonkeyPatch) -> None:
    # resolve_exec_path is the live-IDE guard: when it raises, preview_url is
    # NEVER reached (clean-fail, no browser fallback). The error propagates out of
    # open_url() for the CLI to turn into a non-zero exit.
    previewed = _stub_seams(monkeypatch, resolve_raises=IdeaError("no JetBrains IDE in the process ancestry"))

    with pytest.raises(IdeaError):
        open_url_fn("http://localhost:3000")
    assert previewed == []


def test_open_url_resolve_not_implemented_propagates(monkeypatch: pytest.MonkeyPatch) -> None:
    # The non-macOS stub raises NotImplementedError; it must propagate too.
    previewed = _stub_seams(monkeypatch, resolve_raises=NotImplementedError("resolve_exec_path stub"))

    with pytest.raises(NotImplementedError):
        open_url_fn("http://localhost:3000")
    assert previewed == []


# --- main() CLI: validation, exit codes, graceful path ----------------------


def _capture_open_url(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, object]]:
    """Replace open_url.open_url with a recorder; return the captured calls."""
    captured: list[dict[str, object]] = []

    def fake(url: str, title: str | None = None) -> None:
        captured.append({"url": url, "title": title})

    monkeypatch.setattr(open_url, "open_url", fake)
    return captured


def test_main_url_only_delegates_and_exits_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_open_url(monkeypatch)
    assert open_url.main(["http://localhost:3000"]) == 0
    assert captured == [{"url": "http://localhost:3000", "title": None}]


def test_main_https_is_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_open_url(monkeypatch)
    assert open_url.main(["https://example.com"]) == 0
    assert captured == [{"url": "https://example.com", "title": None}]


def test_main_title_flag_reaches_util(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_open_url(monkeypatch)
    assert open_url.main(["http://localhost:3000", "--title", "Dev"]) == 0
    assert captured == [{"url": "http://localhost:3000", "title": "Dev"}]


@pytest.mark.parametrize(
    "bad",
    ["", "localhost:3000", "ftp://host/x", "file:///etc/hosts", "/just/a/path", "ws://localhost:3000"],
    ids=["empty", "no-scheme", "ftp", "file", "bare-path", "ws"],
)
def test_main_rejects_non_http_url(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], bad: str
) -> None:
    # Light validation: anything that is not an http/https URL is rejected up
    # front with a clear note and exit 1 — the util is never reached.
    captured = _capture_open_url(monkeypatch)
    assert open_url.main([bad]) == 1
    assert captured == []
    assert "open_url:" in capsys.readouterr().err


def test_main_missing_url_is_usage_error(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    # No positional -> argparse exits 2 (SystemExit) and the util is never called.
    _capture_open_url(monkeypatch)
    with pytest.raises(SystemExit) as exc:
        open_url.main([])
    assert exc.value.code == 2
    assert "usage:" in capsys.readouterr().err


def test_main_no_live_ide_returns_1(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    # No running IDE -> open_url raises IdeaError -> exit 1 on stderr. There
    # is deliberately no shell-out to an external browser.
    def boom(url: str, title: str | None = None) -> None:
        raise IdeaError("no JetBrains IDE in the process ancestry")

    monkeypatch.setattr(open_url, "open_url", boom)
    assert open_url.main(["http://localhost:3000"]) == 1
    assert "open_url:" in capsys.readouterr().err


def test_main_outside_jetbrains_returns_1_before_work(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # Cheap CLI gate: outside a JetBrains terminal in_idea() is False, so main()
    # exits 1 with the canonical resolver message and never reaches open_url().
    monkeypatch.setattr(open_url, "in_idea", lambda: False)
    captured = _capture_open_url(monkeypatch)
    assert open_url.main(["http://localhost:3000"]) == 1
    assert captured == []
    assert "open_url: no JetBrains IDE in the process ancestry" in capsys.readouterr().err


def test_main_non_macos_stub_returns_1(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    # A non-macOS stub platform raises NotImplementedError -> exit 1, same as the
    # no-IDE case (clean-fail, no browser fallback).
    def boom(url: str, title: str | None = None) -> None:
        raise NotImplementedError("resolve_exec_path is not implemented for Linux yet")

    monkeypatch.setattr(open_url, "open_url", boom)
    assert open_url.main(["http://localhost:3000"]) == 1
    assert "open_url:" in capsys.readouterr().err


def test_main_graceful_path_exits_zero(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    # The end-to-end clean path through the real open_url(): the IDE guard passes
    # (stubbed) and preview_url is a no-op recorder -> exit 0, nothing on stderr.
    previewed = _stub_seams(monkeypatch)
    assert open_url.main(["http://localhost:3000"]) == 0
    assert previewed == [{"url": "http://localhost:3000", "title": None}]
    assert capsys.readouterr().err == ""


def test_main_returns_int_not_none(monkeypatch: pytest.MonkeyPatch) -> None:
    # main() must return an int exit code (consumed by SystemExit), never None.
    _stub_seams(monkeypatch)
    result = open_url.main(["http://localhost:3000"])
    assert isinstance(result, int)
