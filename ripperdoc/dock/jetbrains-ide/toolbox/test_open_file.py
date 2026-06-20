"""Tests for open_file - hermetic: no real IDE, no real subprocess.

resolve_exec_path / subprocess.Popen are monkeypatched on the open_file module so
the launch runs against a fake IDE and never spawns a real process. The default
path blocks by joining on the launcher (`--wait`), so the Popen stub is
wait-capable; --no-wait is fire-and-forget. A failed spawn's OSError is not
swallowed: it propagates to main() -> exit 1.
"""

import types
from pathlib import Path

import open_file
import pytest
from core import JetBrainsError
from open_file import open_file as open_file_fn

FAKE_IDE = "/Applications/WebStorm.app/Contents/MacOS/webstorm"


# --- open_file launch -------------------------------------------------------


def _stub_popen(calls: list[list[str]]) -> object:
    """A subprocess.Popen stub: records argv, spawns nothing, exposes .wait().

    open_file() blocks by default (`--wait`) by joining on the launcher, so the
    returned object must carry a .wait(); it returns 0 (its value is unused).
    """

    def popen(cmd: list[str], *_args: object, **_kwargs: object) -> types.SimpleNamespace:
        calls.append(cmd)
        return types.SimpleNamespace(pid=4321, wait=lambda: 0)

    return popen


def test_open_file_blocks_by_default(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(open_file, "resolve_exec_path", lambda: FAKE_IDE)
    calls: list[list[str]] = []
    monkeypatch.setattr(open_file.subprocess, "Popen", _stub_popen(calls))

    target = tmp_path / "thing.py"
    assert open_file_fn(str(target)) is None
    # Default blocks: --line only (no --column), resolved target, trailing --wait.
    assert calls == [[FAKE_IDE, "--line", "1", str(target.resolve()), "--wait"]]
    assert "--column" not in calls[0]


def test_open_file_column_threads_into_argv(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(open_file, "resolve_exec_path", lambda: FAKE_IDE)
    calls: list[list[str]] = []
    monkeypatch.setattr(open_file.subprocess, "Popen", _stub_popen(calls))

    target = tmp_path / "thing.py"
    assert open_file_fn(str(target), 12, 5) is None
    # --column sits right after the --line pair, before the resolved target;
    # the default-blocking --wait is appended last.
    assert calls == [[FAKE_IDE, "--line", "12", "--column", "5", str(target.resolve()), "--wait"]]


def test_open_file_no_wait_is_fire_and_forget(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(open_file, "resolve_exec_path", lambda: FAKE_IDE)
    calls: list[list[str]] = []
    monkeypatch.setattr(open_file.subprocess, "Popen", _stub_popen(calls))

    target = tmp_path / "thing.py"
    # wait=False -> bare launch, no trailing --wait.
    assert open_file_fn(str(target), wait=False) is None
    assert calls == [[FAKE_IDE, "--line", "1", str(target.resolve())]]
    assert "--wait" not in calls[0]


# --- main() argv handling ---------------------------------------------------


def _capture_open_file(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, object]]:
    """Replace open_file.open_file with a recorder; return the captured calls."""
    captured: list[dict[str, object]] = []

    def fake(path: str, line: int = 1, column: int | None = None, *, wait: bool = True) -> None:
        captured.append({"path": path, "line": line, "column": column, "wait": wait})

    monkeypatch.setattr(open_file, "open_file", fake)
    return captured


def test_main_path_only_defaults_line_one_no_column(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_open_file(monkeypatch)
    assert open_file.main(["/x/foo.py"]) == 0
    # Default: blocking (wait=True).
    assert captured == [{"path": "/x/foo.py", "line": 1, "column": None, "wait": True}]


def test_main_parses_line_and_column(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_open_file(monkeypatch)
    assert open_file.main(["/x/foo.py", "--line", "42", "--column", "7"]) == 0
    assert captured == [{"path": "/x/foo.py", "line": 42, "column": 7, "wait": True}]


def test_main_no_wait_flag_reaches_util(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_open_file(monkeypatch)
    assert open_file.main(["/x/foo.py", "--no-wait"]) == 0
    # --no-wait -> wait=False.
    assert captured == [{"path": "/x/foo.py", "line": 1, "column": None, "wait": False}]


def test_main_flags_order_independent(monkeypatch: pytest.MonkeyPatch) -> None:
    # Flags may precede the positional path and interleave with --no-wait.
    captured = _capture_open_file(monkeypatch)
    assert open_file.main(["--column", "7", "--no-wait", "--line", "42", "/x/foo.py"]) == 0
    assert captured == [{"path": "/x/foo.py", "line": 42, "column": 7, "wait": False}]


def test_main_missing_path_returns_2(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    captured = _capture_open_file(monkeypatch)
    assert open_file.main([]) == 2
    # Flags without a path are still a usage error, and the util is never called.
    assert open_file.main(["--line", "3"]) == 2
    assert captured == []
    assert "usage: open_file.py" in capsys.readouterr().err


def test_main_flag_without_value_returns_2(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    captured = _capture_open_file(monkeypatch)
    assert open_file.main(["/x/foo.py", "--line"]) == 2
    assert captured == []
    assert "usage: open_file.py" in capsys.readouterr().err


def test_main_non_integer_line_returns_1(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    # A bad int surfaces as ValueError -> exit 1 (consistent with the util's
    # JetBrainsError/OSError/ValueError handling), not a usage error.
    _capture_open_file(monkeypatch)
    assert open_file.main(["/x/foo.py", "--line", "notanint"]) == 1
    assert "open_file:" in capsys.readouterr().err


def test_main_no_live_ide_returns_1(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    # No running IDE -> resolve_exec_path raises JetBrainsError -> exit 1.
    def boom() -> str:
        raise JetBrainsError("no running JetBrains IDE found")

    monkeypatch.setattr(open_file, "resolve_exec_path", boom)
    assert open_file.main(["/x/foo.py"]) == 1
    assert "open_file:" in capsys.readouterr().err


def test_main_popen_oserror_returns_1(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    # A failed spawn is NOT swallowed: Popen's OSError propagates to main() ->
    # exit 1 (mirrors diff_file.py), rather than silently exiting 0.
    monkeypatch.setattr(open_file, "resolve_exec_path", lambda: FAKE_IDE)

    def boom(cmd: list[str], *_a: object, **_k: object) -> object:
        raise OSError("cannot spawn IDE")

    monkeypatch.setattr(open_file.subprocess, "Popen", boom)
    assert open_file.main(["/x/foo.py"]) == 1
    assert "open_file:" in capsys.readouterr().err
