"""Tests for ding — hermetic: no real audio, no sound subprocess.

ding plays the host OS's notification "ding". The side-effecting seams are
monkeypatched so the suite is silent and identical on every OS:

- _run(cmd) -> bool: the subprocess seam every macOS/Linux mechanism rides.
- _terminal_bell(): the universal ASCII-bell fallback.
- _platform_worker(): the sys.platform dispatch, so ding()'s glue is testable on
  any host without touching sys.platform.

Layers exercised: each per-OS worker's selection logic, ding()'s
mechanism-or-bell contract, the thin _run/_terminal_bell seams against real
(silent) subprocess/stream behavior, and the CLI (defaults, --verbose, exit 0).
"""

import sys
from collections.abc import Callable

import os_ding as ding
import pytest


def _fake_run(monkeypatch: pytest.MonkeyPatch, ok: Callable[[list[str]], bool]) -> list[list[str]]:
    """Install a fake `_run` that records each argv and returns `ok(cmd)`.

    Returns the recording list so a test can assert which commands were tried and
    in what order — nothing is spawned."""
    calls: list[list[str]] = []

    def fake(cmd: list[str]) -> bool:
        calls.append(cmd)
        return ok(cmd)

    monkeypatch.setattr(ding, "_run", fake)
    return calls


# --- _run: the subprocess seam (real, silent commands — no sound) ------------


def test_run_false_for_missing_binary() -> None:
    # A binary that doesn't exist -> FileNotFoundError, swallowed to False.
    assert ding._run(["preemdeck-no-such-binary-zzz"]) is False


def test_run_true_for_zero_exit() -> None:
    # A real command that exits 0 -> True (python no-op; nothing audible).
    assert ding._run([sys.executable, "-c", "pass"]) is True


def test_run_false_for_nonzero_exit() -> None:
    assert ding._run([sys.executable, "-c", "raise SystemExit(3)"]) is False


# --- macOS worker: afplay -> osascript -> None -------------------------------


def test_macos_prefers_afplay(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _fake_run(monkeypatch, lambda cmd: True)
    assert ding._ding_macos() == "afplay"
    # afplay is the first (and, on success, only) thing tried.
    assert calls[0][0] == "afplay"
    assert len(calls) == 1


def test_macos_falls_back_to_osascript(monkeypatch: pytest.MonkeyPatch) -> None:
    # afplay fails; the osascript beep succeeds.
    calls = _fake_run(monkeypatch, lambda cmd: cmd[0] == "osascript")
    assert ding._ding_macos() == "osascript"
    assert calls[0][0] == "afplay"  # afplay tried first
    assert calls[-1][:2] == ["osascript", "-e"]


def test_macos_none_when_all_fail(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_run(monkeypatch, lambda cmd: False)
    assert ding._ding_macos() is None


# --- Linux worker: first installed player in the chain wins ------------------


def test_linux_uses_first_player_that_succeeds(monkeypatch: pytest.MonkeyPatch) -> None:
    # canberra (first) fails, paplay succeeds -> stop there, never reach aplay.
    calls = _fake_run(monkeypatch, lambda cmd: cmd[0] == "paplay")
    assert ding._ding_linux() == "paplay"
    tried = [c[0] for c in calls]
    assert tried[0] == "canberra-gtk-play"
    assert "aplay" not in tried


def test_linux_none_when_no_player(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _fake_run(monkeypatch, lambda cmd: False)
    assert ding._ding_linux() is None
    # Every candidate was attempted before giving up.
    assert len(calls) == len(ding._LINUX_CANDIDATES)


# --- ding(): mechanism-or-bell glue (platform-independent) -------------------


def test_ding_returns_mechanism_and_skips_bell(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ding, "_platform_worker", lambda: lambda: "afplay")
    rang: list[bool] = []
    monkeypatch.setattr(ding, "_terminal_bell", lambda: rang.append(True))
    assert ding.ding() == "afplay"
    assert rang == []  # a real mechanism fired -> no bell


def test_ding_falls_back_to_bell(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ding, "_platform_worker", lambda: lambda: None)
    rang: list[bool] = []
    monkeypatch.setattr(ding, "_terminal_bell", lambda: rang.append(True))
    assert ding.ding() == "bell"
    assert rang == [True]  # rang exactly once


def test_terminal_bell_writes_bel(capsys: pytest.CaptureFixture[str]) -> None:
    ding._terminal_bell()
    assert "\a" in capsys.readouterr().err


# --- main() CLI: defaults, --verbose, exit code ------------------------------


def test_main_returns_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ding, "ding", lambda: "afplay")
    assert ding.main([]) == 0


def test_main_quiet_by_default(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setattr(ding, "ding", lambda: "afplay")
    assert ding.main([]) == 0
    assert capsys.readouterr().err == ""


@pytest.mark.parametrize("flag", ["-v", "--verbose"])
def test_main_verbose_prints_mechanism(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], flag: str
) -> None:
    monkeypatch.setattr(ding, "ding", lambda: "afplay")
    assert ding.main([flag]) == 0
    assert "ding: afplay" in capsys.readouterr().err


def test_main_returns_int(monkeypatch: pytest.MonkeyPatch) -> None:
    # main() must return an int exit code (consumed by SystemExit), never None.
    monkeypatch.setattr(ding, "ding", lambda: "afplay")
    assert isinstance(ding.main([]), int)
