"""Tests for core._reap - hermetic: no real sleep blocks the suite.

reap_later spawns a NON-DAEMON thread that sleeps `delay` then unlinks each
path. Catching that thread by polling threading.enumerate() races the reaper
(a delay=0 worker can finish before we look), so instead we gate the seam: the
reaper's time.sleep is monkeypatched to block on an Event the test controls.
That makes the worker provably alive at a known point - we grab it, make our
assertions, then release it and join. No test waits on wall-clock time.
"""

import threading
import time
from pathlib import Path

import pytest

from core import reap_later
from core import _reap


class _Gate:
    """A controllable stand-in for time.sleep: records the delay it was handed,
    signals that the worker reached it, then parks the worker until released."""

    def __init__(self) -> None:
        self.slept: list[float] = []
        self.entered = threading.Event()  # set when the worker reaches sleep
        self.release = threading.Event()  # test holds the worker until it sets this

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.entered.set()
        # Park here instead of a wall-clock wait, so the worker is alive and
        # catchable while the test inspects thread state.
        assert self.release.wait(timeout=5), "test never released the reaper"


def _gated_reap(
    monkeypatch: pytest.MonkeyPatch, paths, *, delay: float = _reap.REAP_DELAY
) -> tuple[threading.Thread, _Gate]:
    """Run reap_later with its sleep gated; return (spawned thread, gate). The
    worker is parked inside the gate's sleep, so exactly one new thread is live."""
    gate = _Gate()
    monkeypatch.setattr(_reap.time, "sleep", gate.sleep)

    before = set(threading.enumerate())
    reap_later(paths, delay=delay)

    assert gate.entered.wait(timeout=5), "reaper never reached sleep"
    new = [t for t in threading.enumerate() if t not in before]
    assert len(new) == 1, f"expected exactly one spawned thread, got {new!r}"
    return new[0], gate


def _finish(thread: threading.Thread, gate: _Gate) -> None:
    """Release the parked worker and join it (runs the unlink)."""
    gate.release.set()
    thread.join(timeout=5)
    assert not thread.is_alive()


def test_reap_later_unlinks_paths(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    a = tmp_path / "a.txt"
    b = tmp_path / "b.txt"
    a.write_text("a")
    b.write_text("b")

    thread, gate = _gated_reap(monkeypatch, [a, b])
    _finish(thread, gate)

    # Both temps are gone once the reaper has run past the (gated) sleep.
    assert not a.exists()
    assert not b.exists()


def test_reap_later_accepts_str_and_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    a = tmp_path / "a.txt"  # passed as str
    b = tmp_path / "b.txt"  # passed as Path
    a.write_text("a")
    b.write_text("b")

    thread, gate = _gated_reap(monkeypatch, [str(a), b])
    _finish(thread, gate)

    assert not a.exists()
    assert not b.exists()


def test_reap_later_missing_path_does_not_raise(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    present = tmp_path / "present.txt"
    present.write_text("x")
    missing = tmp_path / "nope.txt"  # never created

    # A missing path is swallowed (unlink(missing_ok=True)); the reaper never
    # raises, and it still reaps the path that does exist.
    thread, gate = _gated_reap(monkeypatch, [missing, present])
    _finish(thread, gate)  # asserts the worker finished cleanly, didn't die on an error

    assert not present.exists()


def test_reap_later_tolerates_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    # Empty iterable: the reaper just sleeps and unlinks nothing - no error.
    thread, gate = _gated_reap(monkeypatch, [])
    _finish(thread, gate)


def test_reap_later_spawns_non_daemon_thread(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    a = tmp_path / "a.txt"
    a.write_text("a")

    thread, gate = _gated_reap(monkeypatch, [a])
    # Non-daemon is deliberate: the interpreter waits for it at exit, so CLI
    # cleanup is guaranteed rather than killed.
    assert thread.daemon is False
    _finish(thread, gate)


def test_reap_later_is_handed_the_delay(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    a = tmp_path / "a.txt"
    a.write_text("a")

    # The worker's sleep is called with exactly the delay reap_later was given.
    thread, gate = _gated_reap(monkeypatch, [a], delay=42.0)
    assert gate.slept == [42.0]
    _finish(thread, gate)


def test_reap_later_default_delay_is_one_second(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    a = tmp_path / "a.txt"
    a.write_text("a")

    # Called without delay -> the REAP_DELAY default (1.0s) reaches the sleep.
    assert _reap.REAP_DELAY == 1.0
    thread, gate = _gated_reap(monkeypatch, [a])
    assert gate.slept == [_reap.REAP_DELAY]
    _finish(thread, gate)


def test_reap_later_returns_promptly_without_waiting_delay(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    a = tmp_path / "a.txt"
    a.write_text("a")

    # The worker is parked inside the gated sleep (a 1-hour delay it never actually
    # waits out). reap_later must return at once anyway - it never joins the worker.
    start = time.monotonic()
    thread, gate = _gated_reap(monkeypatch, [a], delay=3600)  # an hour; a join would hang
    elapsed = time.monotonic() - start

    assert elapsed < 1.0  # returned immediately, did not wait out `delay`
    assert gate.slept == [3600]

    _finish(thread, gate)
    assert not a.exists()
