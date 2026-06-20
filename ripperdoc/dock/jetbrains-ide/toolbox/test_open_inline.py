"""Tests for open_inline - hermetic: no real IDE, no real subprocess, no polling.

open_inline.open_file is monkeypatched with a recording stub that, at call time
(before open_inline runs any cleanup), captures the temp path + wait flag AND
reads the temp file's contents back off disk. It returns "EDITED\n" on the wait
path and None otherwise, mirroring the real open_file contract. This lets us
assert both what open_inline wrote into the temp and how it cleans up:
  * wait=True  -> temp held exactly `content`, returns the edited text, temp is
    unlinked afterward.
  * wait=False -> launched async, returns None, and the temp is scheduled for a
    deferred reap (open_inline.reap_later, mocked here as a spy - not actually run).
A JetBrainsError out of open_file surfaces as exit 1.
"""

import os
from pathlib import Path

import open_inline
import pytest
from core import JetBrainsError
from open_inline import open_inline as open_inline_fn

EDITED = "EDITED\n"


class _Recorder:
    """An open_file() stub: records path + wait and reads the temp's contents now."""

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def __call__(self, path: str, line: int = 1, column: int | None = None, *, wait: bool = False) -> str | None:
        # Read the temp BEFORE open_inline's cleanup can touch it.
        seen = Path(path).read_text()
        self.calls.append({"path": path, "wait": wait, "seen": seen})
        return EDITED if wait else None


# --- open_inline ------------------------------------------------------------


def test_open_inline_wait_roundtrips_and_cleans_up(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _Recorder()
    monkeypatch.setattr(open_inline, "open_file", rec)

    content = "hello inline\nsecond line\n"
    # wait=True: temp written with exactly `content`, edited text returned.
    assert open_inline_fn(content, wait=True) == EDITED
    assert len(rec.calls) == 1
    call = rec.calls[0]
    assert call["wait"] is True
    # The file open_file was handed contained exactly the input content.
    assert call["seen"] == content
    # Default suffix is .txt.
    path = str(call["path"])
    assert path.endswith(".txt")
    # And the temp is gone once open_inline returns on the wait path.
    assert not os.path.exists(path)


def test_open_inline_no_wait_returns_none_and_schedules_reap(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _Recorder()
    monkeypatch.setattr(open_inline, "open_file", rec)
    # Spy on the reap seam so nothing is actually deleted (no real thread/sleep):
    # we only assert the temp was *scheduled* for deferred cleanup.
    reaped: list[list[str]] = []
    monkeypatch.setattr(open_inline, "reap_later", lambda paths: reaped.append(list(paths)))

    content = "fire and forget\n"
    # wait=False: launch async, return None.
    assert open_inline_fn(content) is None
    assert len(rec.calls) == 1
    call = rec.calls[0]
    assert call["wait"] is False
    assert call["seen"] == content
    # Documented behavior: instead of leaking, the temp is handed to reap_later for
    # a deferred unlink (exactly once, with the one temp path).
    path = str(call["path"])
    assert reaped == [[path]]
    # The seam is mocked, so the temp is still on disk here; clean it up ourselves.
    assert os.path.exists(path)
    os.unlink(path)


def test_open_inline_suffix_override_threads_to_temp_name(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _Recorder()
    monkeypatch.setattr(open_inline, "open_file", rec)

    # Custom suffix shows up on the temp path (drives IDE syntax highlighting).
    assert open_inline_fn("print('hi')\n", suffix=".py", wait=True) == EDITED
    path = str(rec.calls[0]["path"])
    assert path.endswith(".py")
    assert not os.path.exists(path)  # wait path still cleans up


def test_open_inline_jetbrains_error_propagates(monkeypatch: pytest.MonkeyPatch) -> None:
    # open_file is the live-IDE guard: its JetBrainsError propagates out.
    seen_paths: list[str] = []

    def boom(path: str, *_a: object, **_k: object) -> str | None:
        seen_paths.append(path)
        raise JetBrainsError("no running JetBrains IDE found")

    monkeypatch.setattr(open_inline, "open_file", boom)
    with pytest.raises(JetBrainsError):
        open_inline_fn("oops\n", wait=True)
    # Even on the wait path, the temp gets unlinked by the finally before we exit.
    assert not os.path.exists(seen_paths[0])


# --- main() CLI -------------------------------------------------------------


def _capture_open_inline(monkeypatch: pytest.MonkeyPatch, returns: str | None = None) -> list[dict[str, object]]:
    """Replace open_inline.open_inline with a recorder; return the captured calls."""
    captured: list[dict[str, object]] = []

    def fake(content: str, *, suffix: str = ".txt", wait: bool = False) -> str | None:
        captured.append({"content": content, "suffix": suffix, "wait": wait})
        return returns

    monkeypatch.setattr(open_inline, "open_inline", fake)
    return captured


def test_main_inline_only_defaults_no_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_open_inline(monkeypatch)
    assert open_inline.main(["some text"]) == 0
    # Default: fire-and-forget (wait=False), suffix .txt.
    assert captured == [{"content": "some text", "suffix": ".txt", "wait": False}]


def test_main_suffix_flag_reaches_util(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_open_inline(monkeypatch)
    assert open_inline.main(["x = 1", "--suffix", ".py"]) == 0
    assert captured == [{"content": "x = 1", "suffix": ".py", "wait": False}]


def test_main_wait_flag_reaches_util(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_open_inline(monkeypatch)
    assert open_inline.main(["body", "--wait"]) == 0
    assert captured == [{"content": "body", "suffix": ".txt", "wait": True}]


def test_main_wait_prints_edited_contents(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    # With --wait, the edited text returned by open_inline is echoed verbatim.
    _capture_open_inline(monkeypatch, returns=EDITED)
    assert open_inline.main(["body", "--wait"]) == 0
    out = capsys.readouterr()
    assert out.out == EDITED
    assert out.err == ""


def test_main_no_wait_prints_nothing(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    # Without --wait, open_inline returns None -> nothing on stdout.
    _capture_open_inline(monkeypatch, returns=None)
    assert open_inline.main(["body"]) == 0
    out = capsys.readouterr()
    assert out.out == ""
    assert out.err == ""


def test_main_missing_inline_is_usage_error(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # No positional -> argparse exits 2 (SystemExit) and the util is never called.
    captured = _capture_open_inline(monkeypatch)
    with pytest.raises(SystemExit) as exc:
        open_inline.main([])
    assert exc.value.code == 2
    assert captured == []
    assert "usage:" in capsys.readouterr().err


def test_main_no_live_ide_returns_1(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    # No running IDE -> open_inline raises JetBrainsError -> exit 1 on stderr.
    def boom(*_a: object, **_k: object) -> str | None:
        raise JetBrainsError("no running JetBrains IDE found")

    monkeypatch.setattr(open_inline, "open_inline", boom)
    assert open_inline.main(["body"]) == 1
    assert "open_inline:" in capsys.readouterr().err
