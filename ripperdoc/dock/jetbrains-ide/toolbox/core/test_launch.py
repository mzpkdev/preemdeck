"""Tests for core._launch - hermetic, no real subprocess or IDE.

`subprocess.Popen` is monkeypatched with a recording stub on the _launch module
and `resolve_exec_path` is faked, so we assert the exact spawned argv, whether the
native `--wait` flag is appended, whether `.wait()` is joined on (blocking), and
that JetBrainsError propagates.
"""

import pytest

import core
from core import JetBrainsError, _launch, launch

FAKE_EXEC = "/Applications/WebStorm.app/Contents/MacOS/webstorm"


class _FakePopen:
    """Recording stand-in for subprocess.Popen: captures argv, spies on .wait()."""

    def __init__(self, argv: list[str], **_kwargs: object) -> None:
        self.argv = argv
        self.waited = False

    def wait(self, *_a: object, **_k: object) -> int:
        self.waited = True
        return 0


def test_launch_default_spawns_exact_argv_async(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(core, "resolve_exec_path", lambda: FAKE_EXEC)
    monkeypatch.setattr(_launch.subprocess, "Popen", _FakePopen)

    proc = launch(["diff", "/a", "/b"])

    assert isinstance(proc, _FakePopen)
    assert proc.argv == [FAKE_EXEC, "diff", "/a", "/b"]  # no --wait appended
    assert proc.waited is False  # async: not joined


def test_launch_wait_false_does_not_append_flag_or_join(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(core, "resolve_exec_path", lambda: FAKE_EXEC)
    monkeypatch.setattr(_launch.subprocess, "Popen", _FakePopen)

    proc = launch(["open", "/some/file"], wait=False)

    assert "--wait" not in proc.argv
    assert proc.waited is False


def test_launch_wait_true_appends_flag_at_end_and_blocks(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(core, "resolve_exec_path", lambda: FAKE_EXEC)
    monkeypatch.setattr(_launch.subprocess, "Popen", _FakePopen)

    proc = launch(["open", "/some/file"], wait=True)

    assert isinstance(proc, _FakePopen)
    # --wait is appended at the END of the arg vector.
    assert proc.argv == [FAKE_EXEC, "open", "/some/file", "--wait"]
    assert proc.argv[-1] == "--wait"
    assert proc.waited is True  # blocked: .wait() was joined on


def test_launch_returns_the_completed_popen(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(core, "resolve_exec_path", lambda: FAKE_EXEC)
    monkeypatch.setattr(_launch.subprocess, "Popen", _FakePopen)

    proc = launch([], wait=True)

    assert isinstance(proc, _FakePopen)
    assert proc.waited is True


def test_launch_propagates_jetbrains_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom() -> str:
        raise JetBrainsError("no JetBrains IDE in the process ancestry")

    monkeypatch.setattr(core, "resolve_exec_path", boom)
    # Popen must never be reached when resolution fails.
    monkeypatch.setattr(
        _launch.subprocess,
        "Popen",
        lambda *_a, **_k: pytest.fail("Popen should not be called when resolve raises"),
    )

    with pytest.raises(JetBrainsError):
        launch(["diff", "/a", "/b"])
