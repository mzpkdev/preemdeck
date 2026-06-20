"""Tests for open_file — hermetic: no real IDE, no real subprocess, no polling.

open_file.launch is monkeypatched on the module with a recording stub that
captures the argv it's handed plus the `wait` kwarg, spawns nothing, and returns
a dummy Popen-like object. The contract is fire-and-forget by default
(`wait=False` -> None, no file read); with `wait=True`, launch() blocks on the
IDE's native --wait and open_file reads the file back afterward, returning its
contents whether or not the user edited it. An IdeaError out of launch (no
live IDE) surfaces as exit 1.
"""

import types
from pathlib import Path

import open_file
import pytest
from core import IdeaError
from open_file import open_file as open_file_fn

ORIGINAL = "ORIGINAL\n"
EDITED = "EDITED\n"


@pytest.fixture(autouse=True)
def _in_idea(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default the CLI's in_idea() gate to True so main() tests are hermetic.

    main() now fails fast outside a JetBrains terminal; without this the suite
    would depend on the ambient shell. Gate-firing is covered explicitly below.
    """
    monkeypatch.setattr(open_file, "in_idea", lambda: True)


def _stub_launch(calls: list[dict[str, object]], *, edits: str | None = None) -> object:
    """A launch() stub: records argv + wait, spawns nothing, returns a dummy.

    On the wait path it stands in for the user closing the tab: if `edits` is
    given it writes that text to the opened file (the resolved target is the last
    argv element) before returning, simulating an edit; otherwise it leaves the
    file untouched.
    """

    def launch(args: list[str], *, wait: bool = False) -> types.SimpleNamespace:
        calls.append({"args": args, "wait": wait})
        if wait and edits is not None:
            Path(args[-1]).write_text(edits)
        return types.SimpleNamespace(pid=4321)

    return launch


# --- open_file launch -------------------------------------------------------


def test_open_file_fire_and_forget_by_default(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(open_file, "launch", _stub_launch(calls))

    target = tmp_path / "thing.py"
    target.write_text(ORIGINAL)
    # Default wait=False: launch the IDE async, do NOT read, return None.
    assert open_file_fn(str(target)) is None
    # argv carries --line only (no --column) and the resolved target; launch()
    # prepends the IDE exec path itself, so it is absent here. wait=False is
    # threaded straight through (launch appends --wait itself when wait=True).
    assert calls == [{"args": ["--line", "1", str(target.resolve())], "wait": False}]
    assert "--column" not in calls[0]["args"]


def test_open_file_wait_returns_edited_contents(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(open_file, "launch", _stub_launch(calls, edits=EDITED))

    target = tmp_path / "thing.py"
    target.write_text(ORIGINAL)
    # wait=True: launch blocks on native --wait (stub simulates an edit), then
    # open_file reads the file back and returns the edited contents.
    assert open_file_fn(str(target), wait=True) == EDITED
    assert calls == [{"args": ["--line", "1", str(target.resolve())], "wait": True}]


def test_open_file_wait_returns_original_when_untouched(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[dict[str, object]] = []
    # No edits: the user closed the tab without changing anything.
    monkeypatch.setattr(open_file, "launch", _stub_launch(calls))

    target = tmp_path / "thing.py"
    target.write_text(ORIGINAL)
    # Native --wait returns either way: an untouched file reads back as ORIGINAL.
    assert open_file_fn(str(target), wait=True) == ORIGINAL
    assert calls == [{"args": ["--line", "1", str(target.resolve())], "wait": True}]


def test_open_file_column_threads_into_argv(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(open_file, "launch", _stub_launch(calls))

    target = tmp_path / "thing.py"
    target.write_text(ORIGINAL)
    assert open_file_fn(str(target), 12, 5) is None
    # --column sits right after the --line pair, before the resolved target.
    assert calls == [{"args": ["--line", "12", "--column", "5", str(target.resolve())], "wait": False}]


def test_open_file_line_only_argv(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(open_file, "launch", _stub_launch(calls))

    target = tmp_path / "thing.py"
    target.write_text(ORIGINAL)
    assert open_file_fn(str(target), 42) is None
    assert calls == [{"args": ["--line", "42", str(target.resolve())], "wait": False}]
    assert "--column" not in calls[0]["args"]


def test_open_file_launch_idea_error_propagates(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # launch() is the live-IDE guard: its IdeaError propagates out of open_file.
    def boom(_args: list[str], *, wait: bool = False) -> object:
        raise IdeaError("no running JetBrains IDE found")

    monkeypatch.setattr(open_file, "launch", boom)
    with pytest.raises(IdeaError):
        open_file_fn(str(tmp_path / "thing.py"))


# --- open_file --preview ----------------------------------------------------


def test_open_file_default_does_not_set_preview(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # Default path is untouched: without preview, set_preview is NEVER called
    # (no ideScript fires), so the no-flag behavior is byte-for-byte as before.
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(open_file, "launch", _stub_launch(calls))
    previewed: list[str] = []
    monkeypatch.setattr(open_file, "set_preview", lambda target: previewed.append(target))

    target = tmp_path / "thing.md"
    target.write_text(ORIGINAL)
    assert open_file_fn(str(target)) is None
    assert previewed == []


def test_open_file_preview_sets_preview_on_resolved_target(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # With preview=True, set_preview fires once AFTER the open, on the resolved
    # absolute target (the same path launch was handed).
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(open_file, "launch", _stub_launch(calls))
    previewed: list[str] = []
    monkeypatch.setattr(open_file, "set_preview", lambda target: previewed.append(target))

    target = tmp_path / "thing.md"
    target.write_text(ORIGINAL)
    assert open_file_fn(str(target), preview=True) is None
    assert previewed == [str(target.resolve())]
    # The open itself is unchanged — preview is layered on, not a substitute.
    assert calls == [{"args": ["--line", "1", str(target.resolve())], "wait": False}]


def test_open_file_preview_composes_with_line_column_wait(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # --preview must not disturb --line/--column/--wait: the argv carries them all
    # and set_preview still fires on the resolved target after the (wait) open.
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(open_file, "launch", _stub_launch(calls, edits=EDITED))
    previewed: list[str] = []
    monkeypatch.setattr(open_file, "set_preview", lambda target: previewed.append(target))

    target = tmp_path / "thing.md"
    target.write_text(ORIGINAL)
    assert open_file_fn(str(target), 12, 5, wait=True, preview=True) == EDITED
    assert calls == [{"args": ["--line", "12", "--column", "5", str(target.resolve())], "wait": True}]
    assert previewed == [str(target.resolve())]


# --- main() CLI -------------------------------------------------------------


def _capture_open_file(monkeypatch: pytest.MonkeyPatch, returns: str | None = None) -> list[dict[str, object]]:
    """Replace open_file.open_file with a recorder; return the captured calls."""
    captured: list[dict[str, object]] = []

    def fake(
        path: str, line: int = 1, column: int | None = None, *, wait: bool = False, preview: bool = False
    ) -> str | None:
        captured.append({"path": path, "line": line, "column": column, "wait": wait, "preview": preview})
        return returns

    monkeypatch.setattr(open_file, "open_file", fake)
    return captured


def test_main_path_only_defaults_no_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_open_file(monkeypatch)
    assert open_file.main(["/x/foo.py"]) == 0
    # Default: fire-and-forget (wait=False), no preview.
    assert captured == [{"path": "/x/foo.py", "line": 1, "column": None, "wait": False, "preview": False}]


def test_main_parses_line_and_column(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_open_file(monkeypatch)
    assert open_file.main(["/x/foo.py", "--line", "42", "--column", "7"]) == 0
    assert captured == [{"path": "/x/foo.py", "line": 42, "column": 7, "wait": False, "preview": False}]


def test_main_wait_flag_reaches_util(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_open_file(monkeypatch)
    assert open_file.main(["/x/foo.py", "--wait"]) == 0
    # --wait -> wait=True.
    assert captured == [{"path": "/x/foo.py", "line": 1, "column": None, "wait": True, "preview": False}]


def test_main_preview_flag_reaches_util(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_open_file(monkeypatch)
    assert open_file.main(["/x/foo.py", "--preview"]) == 0
    # --preview -> preview=True; everything else stays at its default.
    assert captured == [{"path": "/x/foo.py", "line": 1, "column": None, "wait": False, "preview": True}]


def test_main_no_preview_flag_leaves_preview_false(monkeypatch: pytest.MonkeyPatch) -> None:
    # There is NO --no-preview flag: absence of --preview simply means preview=False.
    captured = _capture_open_file(monkeypatch)
    assert open_file.main(["/x/foo.py"]) == 0
    assert captured[0]["preview"] is False


def test_main_flags_order_independent(monkeypatch: pytest.MonkeyPatch) -> None:
    # argparse accepts optionals before the positional path and in any order.
    captured = _capture_open_file(monkeypatch)
    assert open_file.main(["--column", "7", "--preview", "--wait", "--line", "42", "/x/foo.py"]) == 0
    assert captured == [{"path": "/x/foo.py", "line": 42, "column": 7, "wait": True, "preview": True}]


def test_main_wait_prints_returned_contents(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # With --wait, the file text returned by open_file is echoed verbatim.
    _capture_open_file(monkeypatch, returns=EDITED)
    assert open_file.main(["/x/foo.py", "--wait"]) == 0
    out = capsys.readouterr()
    assert out.out == EDITED
    assert out.err == ""


def test_main_no_wait_prints_nothing(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    # Without --wait, open_file returns None -> nothing on stdout.
    _capture_open_file(monkeypatch, returns=None)
    assert open_file.main(["/x/foo.py"]) == 0
    out = capsys.readouterr()
    assert out.out == ""
    assert out.err == ""


def test_main_missing_path_is_usage_error(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    # No positional -> argparse exits 2 (SystemExit) and the util is never called.
    captured = _capture_open_file(monkeypatch)
    with pytest.raises(SystemExit) as exc:
        open_file.main([])
    assert exc.value.code == 2
    assert captured == []
    assert "usage:" in capsys.readouterr().err


def test_main_non_integer_line_is_usage_error(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # argparse's type=int rejects a bad --line before the util is reached -> exit 2.
    captured = _capture_open_file(monkeypatch)
    with pytest.raises(SystemExit) as exc:
        open_file.main(["/x/foo.py", "--line", "notanint"])
    assert exc.value.code == 2
    assert captured == []
    assert "usage:" in capsys.readouterr().err


def test_main_no_live_ide_returns_1(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    # No running IDE -> open_file raises IdeaError -> exit 1 on stderr.
    def boom(*_a: object, **_k: object) -> str | None:
        raise IdeaError("no running JetBrains IDE found")

    monkeypatch.setattr(open_file, "open_file", boom)
    assert open_file.main(["/x/foo.py"]) == 1
    assert "open_file:" in capsys.readouterr().err


def test_main_outside_jetbrains_returns_1_before_work(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # Cheap CLI gate: outside a JetBrains terminal in_idea() is False, so main()
    # exits 1 with the canonical resolver message and never reaches open_file().
    monkeypatch.setattr(open_file, "in_idea", lambda: False)
    captured = _capture_open_file(monkeypatch)
    assert open_file.main(["/x/foo.py"]) == 1
    assert captured == []
    assert "open_file: no JetBrains IDE in the process ancestry" in capsys.readouterr().err
