"""Tests for the operational layer: lifecycle helpers + the CLI orchestrator.

Two strata:

* Unit — the pure-stdlib helpers in :mod:`wire.lifecycle`: state round-trip,
  the exact handoff render, and ``detect_lan_ip`` over both its UDP path and
  its loopback fallback (socket monkeypatched, no real network).
* Integration — a real, fast ``wire start`` / ``status`` / ``stop`` cycle. The
  state dir is redirected to a tmp dir (``WIRE_STATE_DIR``) so it never touches
  a real ``~/.wire``; the spawned pid is tracked and asserted gone afterward.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time

import pytest

from wire import cli, lifecycle


# -- state round-trip -----------------------------------------------------


@pytest.fixture
def state_dir(tmp_path, monkeypatch):
    """Point the state dir at a tmp dir for the duration of a test."""
    monkeypatch.setenv("WIRE_STATE_DIR", str(tmp_path))
    return tmp_path


def test_state_round_trip(state_dir):
    assert lifecycle.read_state() is None  # nothing yet

    lifecycle.write_state(
        pid=4242,
        host="0.0.0.0",
        port=5557,
        secret="sekret",
        url="http://10.0.0.5:5557",
        topic="design sync",
    )
    state = lifecycle.read_state()
    assert state == {
        "pid": 4242,
        "host": "0.0.0.0",
        "port": 5557,
        "secret": "sekret",
        "url": "http://10.0.0.5:5557",
        "topic": "design sync",
    }
    # file lives at <state_dir>/wire.json and is valid JSON
    assert (state_dir / "wire.json").exists()
    assert json.loads((state_dir / "wire.json").read_text())["port"] == 5557

    lifecycle.clear_state()
    assert lifecycle.read_state() is None
    assert not (state_dir / "wire.json").exists()


def test_clear_state_is_idempotent(state_dir):
    lifecycle.clear_state()  # nothing there → no error
    lifecycle.clear_state()


# -- render_handoff -------------------------------------------------------


def test_render_handoff_exact():
    out = lifecycle.render_handoff("http://192.168.1.20:5555", "abc123")
    expected = (
        "Send this prompt to your other agents:\n"
        "```bash\n"
        'Execute `curl -s "http://192.168.1.20:5555/shard?secret=abc123"`, '
        "then follow the instructions there as written.\n"
        "```"
    )
    assert out == expected
    # the substituted url + secret both land in the block
    assert "http://192.168.1.20:5555/shard?secret=abc123" in out


# -- detect_lan_ip --------------------------------------------------------


def test_detect_lan_ip_udp_path(monkeypatch):
    """The happy path returns getsockname()[0] from the connected UDP socket."""

    class _FakeSock:
        def __init__(self, *a, **k):
            pass

        def connect(self, addr):
            pass

        def getsockname(self):
            return ("192.168.50.7", 54321)

        def close(self):
            pass

    monkeypatch.setattr(lifecycle.socket, "socket", _FakeSock)
    assert lifecycle.detect_lan_ip() == "192.168.50.7"


def test_detect_lan_ip_fallback(monkeypatch):
    """On any socket failure (no route), fall back to loopback."""

    closed = {"called": False}

    class _FailSock:
        def __init__(self, *a, **k):
            pass

        def connect(self, addr):
            raise OSError("network is unreachable")

        def getsockname(self):  # pragma: no cover - never reached
            raise AssertionError("should not be called after connect fails")

        def close(self):
            closed["called"] = True

    monkeypatch.setattr(lifecycle.socket, "socket", _FailSock)
    assert lifecycle.detect_lan_ip() == "127.0.0.1"
    assert closed["called"] is True  # socket still closed on the failure path


def test_detect_lan_ip_returns_str():
    # Real call (whatever the environment) must yield a string.
    assert isinstance(lifecycle.detect_lan_ip(), str)


# -- health_ok ------------------------------------------------------------


def test_health_ok_down_when_nothing_listening():
    # Port 1 is never our server; the connection refuses → down.
    assert lifecycle.health_ok("127.0.0.1", 1, timeout=0.5) is False


@pytest.mark.parametrize("body", [b'{"status":"degraded"}', b"not json at all"])
def test_health_ok_down_on_bad_body(monkeypatch, body):
    """A 200 whose body isn't {"status":"ok"} — incl. non-JSON — reads as down."""

    class _FakeResp:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return body

    monkeypatch.setattr(lifecycle.urllib.request, "urlopen", lambda *a, **k: _FakeResp())
    assert lifecycle.health_ok("127.0.0.1", 5555, timeout=0.5) is False


# -- cli unit: pure functions, no process orchestration -------------------


def test_find_free_port_exhaustion(monkeypatch):
    """When every probed port is busy, _find_free_port raises RuntimeError."""

    def _always_busy(self, addr):
        raise OSError("address in use")

    monkeypatch.setattr(cli.socket.socket, "bind", _always_busy)
    with pytest.raises(RuntimeError, match="no free port"):
        cli._find_free_port("127.0.0.1", 5555, attempts=3)


def test_stop_clears_stale_state(state_dir, monkeypatch):
    """A state file whose pid is dead → stop cleans up and exits 0, no signal."""
    lifecycle.write_state(
        pid=999999,
        host="127.0.0.1",
        port=5557,
        secret="s",
        url="http://127.0.0.1:5557",
        topic="t",
    )
    # Pin the pid as dead so the stale-state branch is hit deterministically,
    # never signalling a real process that happens to own pid 999999.
    monkeypatch.setattr(cli, "_pid_alive", lambda pid: False)

    rc = cli._cmd_stop(argparse.Namespace())
    assert rc == 0
    assert lifecycle.read_state() is None


# -- integration: start → status → stop -----------------------------------

WIRE_PKG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(lifecycle.__file__)))


def _run_wire(args, state_dir, timeout=20):
    """Invoke ``python -m wire …`` with the tmp state dir, capturing output."""
    env = dict(os.environ, WIRE_STATE_DIR=str(state_dir), PYTHONPATH=WIRE_PKG_DIR)
    return subprocess.run(
        [sys.executable, "-m", "wire", *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
    )


def _read_pid(state_dir):
    raw = (state_dir / "wire.json").read_text()
    return json.loads(raw)["pid"]


def test_start_status_stop_cycle(state_dir):
    pid = None
    try:
        # start: spawns detached, prints the handoff, writes state, health up.
        r = _run_wire(["start", "--topic", "t", "--secret", "s", "--host", "127.0.0.1"], state_dir)
        assert r.returncode == 0, f"start failed: {r.stderr}\n{r.stdout}"
        assert "Send this prompt to your other agents:" in r.stdout
        assert "/shard?secret=s" in r.stdout

        state = lifecycle.read_state()
        assert state is not None
        pid = state["pid"]
        assert state["host"] == "127.0.0.1"
        assert state["secret"] == "s"
        # handoff carries the real url + secret
        assert state["url"] in r.stdout
        assert lifecycle.health_ok(state["host"], state["port"]) is True

        # status: reports up with the address + secret.
        r = _run_wire(["status"], state_dir)
        assert r.returncode == 0
        assert "wire: up" in r.stdout
        assert f"port:   {state['port']}" in r.stdout
        assert "secret: s" in r.stdout

        # stop: health goes down, state cleared.
        r = _run_wire(["stop"], state_dir)
        assert r.returncode == 0, f"stop failed: {r.stderr}\n{r.stdout}"
        assert "stopped" in r.stdout
        assert lifecycle.read_state() is None
        assert lifecycle.health_ok(state["host"], state["port"]) is False

        # status after stop: not running.
        r = _run_wire(["status"], state_dir)
        assert "not running" in r.stdout

        # the spawned process is gone — no strays.
        time.sleep(0.3)
        assert _pid_gone(pid)
        pid = None
    finally:
        if pid is not None:
            _force_kill(pid)


def test_start_is_idempotent(state_dir):
    first_pid = None
    try:
        r1 = _run_wire(["start", "--topic", "t", "--secret", "s", "--host", "127.0.0.1"], state_dir)
        assert r1.returncode == 0, f"first start failed: {r1.stderr}"
        first_pid = _read_pid(state_dir)

        # second start: must reuse the live room — same pid, prints handoff, no respawn.
        r2 = _run_wire(["start", "--topic", "t", "--secret", "s", "--host", "127.0.0.1"], state_dir)
        assert r2.returncode == 0, f"second start failed: {r2.stderr}"
        assert "Send this prompt to your other agents:" in r2.stdout
        assert _read_pid(state_dir) == first_pid  # NOT a second server
    finally:
        if first_pid is not None:
            _run_wire(["stop"], state_dir)
            time.sleep(0.3)
            _force_kill(first_pid)


def test_start_without_secret_mints_one(state_dir):
    """`start` with no --secret auto-generates a non-empty token into state.

    The two sibling start tests both pass `--secret s`, so neither hits the
    auto-gen branch (_cmd_start, cli.py ~L153). Here we omit --secret and
    assert state carries a generated, non-empty secret (not a passed-in value).
    """
    pid = None
    try:
        r = _run_wire(["start", "--topic", "t", "--host", "127.0.0.1"], state_dir)
        assert r.returncode == 0, f"start failed: {r.stderr}\n{r.stdout}"
        assert "Send this prompt to your other agents:" in r.stdout

        state = lifecycle.read_state()
        assert state is not None
        pid = state["pid"]
        # The minted secret is present, non-empty, and not the explicit "s"
        # the sibling tests pin — i.e. it was generated, not passed in.
        assert isinstance(state["secret"], str)
        assert state["secret"]
        assert state["secret"] != "s"
        # the handoff carries the same generated secret
        assert f"/shard?secret={state['secret']}" in r.stdout

        # tear down exactly like the sibling cycle test: stop, confirm gone.
        r = _run_wire(["stop"], state_dir)
        assert r.returncode == 0, f"stop failed: {r.stderr}\n{r.stdout}"
        assert lifecycle.read_state() is None
        time.sleep(0.3)
        assert _pid_gone(pid)
        pid = None
    finally:
        if pid is not None:
            _force_kill(pid)


def test_stop_nothing_running(state_dir):
    r = _run_wire(["stop"], state_dir)
    assert r.returncode == 0
    assert "nothing running" in r.stdout


# -- helpers --------------------------------------------------------------


def _pid_gone(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except PermissionError:  # pragma: no cover
        return False
    return False


def _force_kill(pid: int) -> None:
    """Last-ditch cleanup so a failed test can never leak a server."""
    try:
        os.kill(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
