"""Tests for diff - hermetic: no real IDE, no real process spawn, no real viewer.

resolve_exec_path / subprocess.Popen are monkeypatched on the diff module so the
launch runs against a fake IDE and records argv instead of spawning anything. The
blocking viewer is the seam: the stubbed Popen object's .wait() runs a per-test
callback that side-effects the LEFT file (write = the human edited it; no-op =
they only looked), which is exactly what diff() inspects via its snapshot. The
LEFT file is the one the user shapes (and whose final content matters); the right
pane is reference-only, so the left file is watched and right-pane edits are
ignored. Inputs are real files under tmp_path so strict path resolution behaves
like in production: a missing input fails fast, before any launch.
"""

import types
from pathlib import Path
from typing import Callable

import diff_file
import pytest
from core import JetBrainsError
from diff_file import diff_file as diff_fn

FAKE_IDE = "/Applications/WebStorm.app/Contents/MacOS/webstorm"


def _stub_popen(calls: list[list[str]], on_wait: Callable[[], None] = lambda: None) -> object:
    """A subprocess.Popen stub: records argv, and runs `on_wait` when .wait() is called.

    diff() blocks by joining on the launcher (`--wait`); .wait() is where it waits
    on the viewer, so the callback is the place to simulate the human's choice
    (write the left file = edited; no-op = unchanged). The exit code is unused.
    """

    def popen(cmd: list[str], *_args: object, **_kwargs: object) -> object:
        calls.append(cmd)

        def wait() -> int:
            on_wait()
            return 0  # the launcher's exit code is unused by diff()

        return types.SimpleNamespace(pid=4321, wait=wait)

    return popen


def _make_inputs(tmp_path: Path) -> tuple[Path, Path]:
    left = tmp_path / "left.py"
    right = tmp_path / "right.py"
    left.write_text("a\n")
    right.write_text("b\n")
    return left, right


def _make_third(tmp_path: Path) -> Path:
    third = tmp_path / "third.py"
    third.write_text("c\n")
    return third


# --- diff launch ------------------------------------------------------------


def test_diff_threads_resolved_paths_into_argv(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(diff_file, "resolve_exec_path", lambda: FAKE_IDE)
    calls: list[list[str]] = []
    monkeypatch.setattr(diff_file.subprocess, "Popen", _stub_popen(calls))

    left, right = _make_inputs(tmp_path)

    diff_fn(str(left), str(right))
    # Default is blocking: both args resolved to absolute, "diff" subcommand
    # first, order preserved, trailing --wait.
    assert calls == [[FAKE_IDE, "diff", str(left.resolve()), str(right.resolve()), "--wait"]]


def test_diff_no_wait_drops_wait_flag(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(diff_file, "resolve_exec_path", lambda: FAKE_IDE)
    calls: list[list[str]] = []
    monkeypatch.setattr(diff_file.subprocess, "Popen", _stub_popen(calls))

    left, right = _make_inputs(tmp_path)

    # wait=False is fire-and-forget: same argv but NO trailing --wait, and there is
    # nothing to join, so edits can't be observed -> returns None.
    assert diff_fn(str(left), str(right), wait=False) is None
    assert calls == [[FAKE_IDE, "diff", str(left.resolve()), str(right.resolve())]]
    assert "--wait" not in calls[0]


def test_diff_missing_input_raises_file_not_found(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(diff_file, "resolve_exec_path", lambda: FAKE_IDE)
    calls: list[list[str]] = []
    monkeypatch.setattr(diff_file.subprocess, "Popen", _stub_popen(calls))

    left = tmp_path / "left.py"
    left.write_text("a\n")
    missing = tmp_path / "nope.py"

    # strict=True -> a missing input fails before anything is spawned.
    with pytest.raises(FileNotFoundError):
        diff_fn(str(left), str(missing))
    assert calls == []


# --- 3-way diff (comparison-only: passthrough, no edit detection) -----------


def test_diff_three_way_threads_third_into_argv(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(diff_file, "resolve_exec_path", lambda: FAKE_IDE)
    calls: list[list[str]] = []
    monkeypatch.setattr(diff_file.subprocess, "Popen", _stub_popen(calls))

    left, right = _make_inputs(tmp_path)
    third = _make_third(tmp_path)

    # Three positionals pass straight through in order (L M R) with trailing --wait,
    # and 3-way is comparison-only -> None even though blocking.
    assert diff_fn(str(left), str(right), str(third)) is None
    assert calls == [[FAKE_IDE, "diff", str(left.resolve()), str(right.resolve()), str(third.resolve()), "--wait"]]


def test_diff_three_way_no_wait_drops_wait_flag(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(diff_file, "resolve_exec_path", lambda: FAKE_IDE)
    calls: list[list[str]] = []
    monkeypatch.setattr(diff_file.subprocess, "Popen", _stub_popen(calls))

    left, right = _make_inputs(tmp_path)
    third = _make_third(tmp_path)

    # wait=False is fire-and-forget for 3-way too: same passthrough argv but NO
    # trailing --wait, and nothing to observe -> None.
    assert diff_fn(str(left), str(right), str(third), wait=False) is None
    assert calls == [[FAKE_IDE, "diff", str(left.resolve()), str(right.resolve()), str(third.resolve())]]
    assert "--wait" not in calls[0]


def test_diff_three_way_missing_third_raises_file_not_found(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(diff_file, "resolve_exec_path", lambda: FAKE_IDE)
    calls: list[list[str]] = []
    monkeypatch.setattr(diff_file.subprocess, "Popen", _stub_popen(calls))

    left, right = _make_inputs(tmp_path)
    missing = tmp_path / "nope.py"

    # The third positional is resolved strictly like the other two: missing -> raise
    # before any launch.
    with pytest.raises(FileNotFoundError):
        diff_fn(str(left), str(right), str(missing))
    assert calls == []


# --- edit detection (the left pane is the one we watch) ---------------------


def test_diff_edited_when_left_written(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(diff_file, "resolve_exec_path", lambda: FAKE_IDE)
    left, right = _make_inputs(tmp_path)
    # Edited: wait() rewrites the left file so its snapshot changes across the call.
    monkeypatch.setattr(diff_file.subprocess, "Popen", _stub_popen([], lambda: left.write_text("edited\n")))

    assert diff_fn(str(left), str(right)) is True


def test_diff_unchanged_when_left_untouched(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(diff_file, "resolve_exec_path", lambda: FAKE_IDE)
    left, right = _make_inputs(tmp_path)
    # Unchanged: wait() leaves the left file untouched -> snapshot equal -> False.
    monkeypatch.setattr(diff_file.subprocess, "Popen", _stub_popen([], lambda: None))

    assert diff_fn(str(left), str(right)) is False


def test_diff_unchanged_when_only_right_written(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(diff_file, "resolve_exec_path", lambda: FAKE_IDE)
    left, right = _make_inputs(tmp_path)
    # The right pane is reference-only: even when wait() writes ONLY the right file
    # (left untouched), the left snapshot is unchanged -> False. Right edits ignored.
    monkeypatch.setattr(diff_file.subprocess, "Popen", _stub_popen([], lambda: right.write_text("edited\n")))

    assert diff_fn(str(left), str(right)) is False


# --- main() argv handling ---------------------------------------------------


def test_main_two_files_invokes_diff(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(diff_file, "resolve_exec_path", lambda: FAKE_IDE)
    calls: list[list[str]] = []
    monkeypatch.setattr(diff_file.subprocess, "Popen", _stub_popen(calls))

    left, right = _make_inputs(tmp_path)

    assert diff_file.main([str(left), str(right)]) == 0
    assert calls == [[FAKE_IDE, "diff", str(left.resolve()), str(right.resolve()), "--wait"]]


def test_main_edited_prints_edited_returns_0(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(diff_file, "resolve_exec_path", lambda: FAKE_IDE)
    left, right = _make_inputs(tmp_path)
    monkeypatch.setattr(diff_file.subprocess, "Popen", _stub_popen([], lambda: left.write_text("edited\n")))

    # Left edited during the blocked diff -> "edited" on stdout, still exit 0.
    assert diff_file.main([str(left), str(right)]) == 0
    assert capsys.readouterr().out.strip() == "edited"


def test_main_unchanged_prints_unchanged_returns_0(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(diff_file, "resolve_exec_path", lambda: FAKE_IDE)
    left, right = _make_inputs(tmp_path)
    monkeypatch.setattr(diff_file.subprocess, "Popen", _stub_popen([], lambda: None))

    # Unchanged is a valid review outcome, NOT a failure: "unchanged" on stdout, exit 0.
    assert diff_file.main([str(left), str(right)]) == 0
    assert capsys.readouterr().out.strip() == "unchanged"


def test_main_no_wait_drops_wait_flag(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(diff_file, "resolve_exec_path", lambda: FAKE_IDE)
    calls: list[list[str]] = []
    # Even if the left file moved, --no-wait never snapshots, so the outcome
    # cannot depend on it; wire a write to prove main stays silent regardless.
    left, right = _make_inputs(tmp_path)
    monkeypatch.setattr(diff_file.subprocess, "Popen", _stub_popen(calls, lambda: left.write_text("edited\n")))

    # --no-wait -> wait=False -> fire-and-forget argv with no trailing --wait, and
    # main prints nothing (None outcome).
    assert diff_file.main([str(left), str(right), "--no-wait"]) == 0
    assert calls == [[FAKE_IDE, "diff", str(left.resolve()), str(right.resolve())]]
    assert "--wait" not in calls[0]
    assert capsys.readouterr().out == ""


def test_main_three_files_invokes_three_way(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(diff_file, "resolve_exec_path", lambda: FAKE_IDE)
    calls: list[list[str]] = []
    monkeypatch.setattr(diff_file.subprocess, "Popen", _stub_popen(calls))

    left, right = _make_inputs(tmp_path)
    third = _make_third(tmp_path)

    # Three positionals -> 3-way passthrough (L M R) with trailing --wait.
    assert diff_file.main([str(left), str(right), str(third)]) == 0
    assert calls == [[FAKE_IDE, "diff", str(left.resolve()), str(right.resolve()), str(third.resolve()), "--wait"]]


def test_main_three_way_prints_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(diff_file, "resolve_exec_path", lambda: FAKE_IDE)
    left, right = _make_inputs(tmp_path)
    third = _make_third(tmp_path)
    # Even if wait() writes the right file, 3-way never snapshots/detects, so main
    # gets None and stays silent: proves no edit detection in the 3-way path.
    monkeypatch.setattr(diff_file.subprocess, "Popen", _stub_popen([], lambda: right.write_text("edited\n")))

    assert diff_file.main([str(left), str(right), str(third)]) == 0
    assert capsys.readouterr().out == ""


def test_main_three_way_no_wait_drops_wait_flag(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(diff_file, "resolve_exec_path", lambda: FAKE_IDE)
    calls: list[list[str]] = []
    monkeypatch.setattr(diff_file.subprocess, "Popen", _stub_popen(calls))

    left, right = _make_inputs(tmp_path)
    third = _make_third(tmp_path)

    # 3-way + --no-wait -> passthrough argv with NO trailing --wait, None outcome,
    # nothing printed.
    assert diff_file.main([str(left), str(right), str(third), "--no-wait"]) == 0
    assert calls == [[FAKE_IDE, "diff", str(left.resolve()), str(right.resolve()), str(third.resolve())]]
    assert "--wait" not in calls[0]
    assert capsys.readouterr().out == ""


def test_main_three_way_missing_input_returns_1(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(diff_file, "resolve_exec_path", lambda: FAKE_IDE)
    monkeypatch.setattr(diff_file.subprocess, "Popen", _stub_popen([]))

    left, right = _make_inputs(tmp_path)
    missing = tmp_path / "nope.py"

    # A missing path anywhere among the three -> FileNotFoundError (OSError) -> exit 1.
    assert diff_file.main([str(left), str(right), str(missing)]) == 1


def test_main_missing_input_returns_1(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(diff_file, "resolve_exec_path", lambda: FAKE_IDE)
    monkeypatch.setattr(diff_file.subprocess, "Popen", _stub_popen([]))

    left = tmp_path / "left.py"
    left.write_text("a\n")
    missing = tmp_path / "nope.py"

    # FileNotFoundError is an OSError subclass -> rides main's except -> exit 1.
    assert diff_file.main([str(left), str(missing)]) == 1


def test_main_no_live_ide_returns_1(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    def boom() -> str:
        raise JetBrainsError("no live IDE")

    monkeypatch.setattr(diff_file, "resolve_exec_path", boom)
    monkeypatch.setattr(diff_file.subprocess, "Popen", _stub_popen([]))

    left, right = _make_inputs(tmp_path)

    assert diff_file.main([str(left), str(right)]) == 1


def test_main_popen_oserror_returns_1(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # A spawn failure must NOT be swallowed: its OSError rides main's except -> 1.
    monkeypatch.setattr(diff_file, "resolve_exec_path", lambda: FAKE_IDE)

    def boom(cmd: list[str], *_a: object, **_k: object) -> object:
        raise OSError("exec failed")

    monkeypatch.setattr(diff_file.subprocess, "Popen", boom)

    left, right = _make_inputs(tmp_path)

    assert diff_file.main([str(left), str(right)]) == 1


def test_main_wrong_arg_count_returns_2(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    calls: list[list[str]] = []
    monkeypatch.setattr(diff_file, "resolve_exec_path", lambda: FAKE_IDE)
    monkeypatch.setattr(diff_file.subprocess, "Popen", _stub_popen(calls))

    # 2 or 3 positionals are valid now; 0, 1, and 4+ are usage errors and the util
    # is never reached.
    assert diff_file.main([]) == 2
    assert diff_file.main(["/x/only.py"]) == 2
    assert diff_file.main(["/x/a.py", "/x/b.py", "/x/c.py", "/x/d.py"]) == 2
    assert calls == []
    assert "usage: diff_file.py" in capsys.readouterr().err
