"""Tests for open_file - hermetic: no real IDE, no real log polling.

resolve_exec_path / resolve_log_dir / subprocess.Popen are monkeypatched on the
open_file module so the launch and the log-confirm loop run against a fake IDE
and a tmp idea.log. _opened_via_cli is exercised as a pure function: the
no-cross-confirm guarantee (file B's block must not confirm file A) is verified
without any timing.
"""

import types
from pathlib import Path

import open_file
import pytest
from open_file import _opened_via_cli
from open_file import open_file as open_file_fn

FAKE_IDE = "/Applications/WebStorm.app/Contents/MacOS/webstorm"


def _block(target: str) -> list[str]:
    """A real-shaped CommandLineProcessor open block naming `target`."""
    return [
        "2026-06-19 22:00:00,001 [   1234]   INFO - #c.i.i.CommandLineProcessor - External command line:",
        "args: [--line, 1]",
        f"  {target}",
        "2026-06-19 22:00:00,002 [   1235]   INFO - #c.i.i.CommandLineProcessor - Processing command",
    ]


# --- _opened_via_cli: pure precision, no timing -----------------------------


def test_opened_via_cli_true_for_path_inside_block() -> None:
    assert _opened_via_cli(_block("/x/foo.py"), "/x/foo.py") is True


def test_opened_via_cli_no_cross_confirm_two_files() -> None:
    # The log holds only file B's open block; file A merely appears as a loose
    # line outside any block. Querying A must not confirm; querying B must.
    a, b = "/x/alpha.py", "/y/bravo.py"
    lines = [
        f"  {a}",  # loose / Dir-ish line, NOT inside an External command line block
        *_block(b),
    ]
    assert _opened_via_cli(lines, a) is False
    assert _opened_via_cli(lines, b) is True


def test_opened_via_cli_requires_exact_match() -> None:
    # Block opens foo.py.bak; querying foo.py (a prefix) must not confirm.
    assert _opened_via_cli(_block("/x/foo.py.bak"), "/x/foo.py") is False


# --- open_file launch / confirm ---------------------------------------------


def _stub_popen(calls: list[list[str]]) -> object:
    """A subprocess.Popen stub that records argv and spawns nothing."""

    def popen(cmd: list[str], *_args: object, **_kwargs: object) -> types.SimpleNamespace:
        calls.append(cmd)
        return types.SimpleNamespace(pid=4321)

    return popen


def test_open_file_fire_and_forget(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(open_file, "resolve_exec_path", lambda: FAKE_IDE)
    calls: list[list[str]] = []
    monkeypatch.setattr(open_file.subprocess, "Popen", _stub_popen(calls))

    target = tmp_path / "thing.py"
    assert open_file_fn(str(target)) is True
    assert calls == [[FAKE_IDE, "--line", "1", str(target.resolve())]]


def test_open_file_confirm_success(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    log = tmp_path / "idea.log"
    log.write_text("2026-06-19 21:59:59,000 [   1000]   INFO - startup\n")
    monkeypatch.setattr(open_file, "resolve_exec_path", lambda: FAKE_IDE)
    monkeypatch.setattr(open_file, "resolve_log_dir", lambda: tmp_path)

    target = str((tmp_path / "opened.py").resolve())

    def fake_popen(cmd: list[str], *_a: object, **_k: object) -> types.SimpleNamespace:
        # Simulate the IDE appending its open block for the resolved target.
        with log.open("a") as fh:
            fh.write("\n".join(_block(target)) + "\n")
        return types.SimpleNamespace(pid=4321)

    monkeypatch.setattr(open_file.subprocess, "Popen", fake_popen)

    assert open_file_fn(target, confirm=True) is True


def test_open_file_confirm_timeout(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    log = tmp_path / "idea.log"
    log.write_text("2026-06-19 21:59:59,000 [   1000]   INFO - startup\n")
    monkeypatch.setattr(open_file, "resolve_exec_path", lambda: FAKE_IDE)
    monkeypatch.setattr(open_file, "resolve_log_dir", lambda: tmp_path)
    # Keep the poll loop sub-second so a miss fails fast.
    monkeypatch.setattr(open_file, "_CONFIRM_TIMEOUT", 0.05)
    monkeypatch.setattr(open_file, "_CONFIRM_POLL", 0.01)

    wanted = str((tmp_path / "wanted.py").resolve())
    other = str((tmp_path / "other.py").resolve())

    def fake_popen(cmd: list[str], *_a: object, **_k: object) -> types.SimpleNamespace:
        # IDE opens a *different* file - must never confirm `wanted`.
        with log.open("a") as fh:
            fh.write("\n".join(_block(other)) + "\n")
        return types.SimpleNamespace(pid=4321)

    monkeypatch.setattr(open_file.subprocess, "Popen", fake_popen)

    assert open_file_fn(wanted, confirm=True) is False
