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
import contextlib
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

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

        def getsockname(self):  # pragma: no cover — never reached
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


def test_empty_grace_flag_wins(monkeypatch):
    """An explicit flag beats both the env var and the Config default."""
    monkeypatch.setenv("WIRE_EMPTY_GRACE", "42")
    assert cli._empty_grace(7) == 7  # flag wins over env
    monkeypatch.delenv("WIRE_EMPTY_GRACE", raising=False)
    assert cli._empty_grace(7) == 7  # flag wins over default


def test_empty_grace_env_used_when_flag_unset(monkeypatch):
    """With no flag, a valid env value is honoured (incl. 0 = disable)."""
    monkeypatch.setenv("WIRE_EMPTY_GRACE", "120")
    assert cli._empty_grace(None) == 120
    # 0 is meaningful (disables self-close) and must be accepted, not rejected.
    monkeypatch.setenv("WIRE_EMPTY_GRACE", "0")
    assert cli._empty_grace(None) == 0


def test_empty_grace_falls_back_to_default(monkeypatch):
    """No flag + absent/negative/garbage env → the Config default."""
    monkeypatch.delenv("WIRE_EMPTY_GRACE", raising=False)
    assert cli._empty_grace(None) == cli.Config.empty_grace  # env absent
    monkeypatch.setenv("WIRE_EMPTY_GRACE", "-5")
    assert cli._empty_grace(None) == cli.Config.empty_grace  # negative ignored
    monkeypatch.setenv("WIRE_EMPTY_GRACE", "nope")
    assert cli._empty_grace(None) == cli.Config.empty_grace  # unparseable ignored


def test_serve_argv_forwards_empty_grace_when_set():
    """_serve_argv emits --empty-grace=<v> (=value form) iff it is set."""
    args = argparse.Namespace(
        topic="t",
        secret="s",
        host="127.0.0.1",
        port=5555,
        idle_timeout=None,
        sweep_interval=None,
        empty_grace=3,
        max_connections=None,
        public_url=None,
    )
    argv = cli._serve_argv(args)
    assert "--empty-grace=3" in argv
    # other (unset) knobs are NOT forwarded
    assert not any(a.startswith("--idle-timeout") for a in argv)
    assert not any(a.startswith("--sweep-interval") for a in argv)
    assert not any(a.startswith("--max-connections") for a in argv)
    assert not any(a.startswith("--public-url") for a in argv)


def test_serve_argv_omits_empty_grace_when_unset():
    """An unset --empty-grace is omitted so the child resolves env/default."""
    args = argparse.Namespace(
        topic="t",
        secret="s",
        host="127.0.0.1",
        port=5555,
        idle_timeout=None,
        sweep_interval=None,
        empty_grace=None,
        max_connections=None,
        public_url=None,
    )
    argv = cli._serve_argv(args)
    assert not any(a.startswith("--empty-grace") for a in argv)


# -- _max_connections resolver: flag > WIRE_MAX_CONNECTIONS env > default ---


def test_max_connections_flag_wins(monkeypatch):
    """An explicit flag beats both the env var and the Config default."""
    monkeypatch.setenv("WIRE_MAX_CONNECTIONS", "42")
    assert cli._max_connections(7) == 7  # flag wins over env
    monkeypatch.delenv("WIRE_MAX_CONNECTIONS", raising=False)
    assert cli._max_connections(7) == 7  # flag wins over default


def test_max_connections_env_used_when_flag_unset(monkeypatch):
    """With no flag, a valid env value is honoured (incl. 0 = unlimited)."""
    monkeypatch.setenv("WIRE_MAX_CONNECTIONS", "1000")
    assert cli._max_connections(None) == 1000
    # 0 is meaningful (disables the cap → unlimited) and must be accepted.
    monkeypatch.setenv("WIRE_MAX_CONNECTIONS", "0")
    assert cli._max_connections(None) == 0


def test_max_connections_falls_back_to_default(monkeypatch):
    """No flag + absent/negative/garbage env → the Config default (64)."""
    monkeypatch.delenv("WIRE_MAX_CONNECTIONS", raising=False)
    assert cli._max_connections(None) == cli.Config.max_connections  # env absent
    assert cli._max_connections(None) == 64  # the documented default
    monkeypatch.setenv("WIRE_MAX_CONNECTIONS", "-5")
    assert cli._max_connections(None) == cli.Config.max_connections  # negative ignored
    monkeypatch.setenv("WIRE_MAX_CONNECTIONS", "nope")
    assert cli._max_connections(None) == cli.Config.max_connections  # unparseable ignored


def test_serve_argv_forwards_max_connections_when_set():
    """_serve_argv emits --max-connections=<v> (=value form) iff it is set."""
    args = argparse.Namespace(
        topic="t",
        secret="s",
        host="127.0.0.1",
        port=5555,
        idle_timeout=None,
        sweep_interval=None,
        empty_grace=None,
        max_connections=256,
        public_url=None,
    )
    argv = cli._serve_argv(args)
    assert "--max-connections=256" in argv
    # other (unset) knobs are NOT forwarded
    assert not any(a.startswith("--idle-timeout") for a in argv)
    assert not any(a.startswith("--empty-grace") for a in argv)


def test_serve_argv_omits_max_connections_when_unset():
    """An unset --max-connections is omitted so the child resolves env/default."""
    args = argparse.Namespace(
        topic="t",
        secret="s",
        host="127.0.0.1",
        port=5555,
        idle_timeout=None,
        sweep_interval=None,
        empty_grace=None,
        max_connections=None,
        public_url=None,
    )
    argv = cli._serve_argv(args)
    assert not any(a.startswith("--max-connections") for a in argv)


# -- _public_url resolver: flag > env > None, trailing slash stripped -------


def test_public_url_flag_wins(monkeypatch):
    """An explicit flag beats both the env var and the None default."""
    monkeypatch.setenv("WIRE_PUBLIC_URL", "https://env.example.com")
    assert cli._public_url("https://flag.example.com") == "https://flag.example.com"
    monkeypatch.delenv("WIRE_PUBLIC_URL", raising=False)
    assert cli._public_url("https://flag.example.com") == "https://flag.example.com"


def test_public_url_env_used_when_flag_unset(monkeypatch):
    """With no flag, the env value is honoured."""
    monkeypatch.setenv("WIRE_PUBLIC_URL", "https://env.example.com")
    assert cli._public_url(None) == "https://env.example.com"


def test_public_url_none_when_neither(monkeypatch):
    """No flag + absent env → None (today's request/LAN-base behavior)."""
    monkeypatch.delenv("WIRE_PUBLIC_URL", raising=False)
    assert cli._public_url(None) is None


def test_public_url_trailing_slash_stripped(monkeypatch):
    """A trailing slash is normalized off, from either source."""
    monkeypatch.delenv("WIRE_PUBLIC_URL", raising=False)
    assert cli._public_url("https://x.ngrok.io/") == "https://x.ngrok.io"
    monkeypatch.setenv("WIRE_PUBLIC_URL", "https://y.ngrok.io/")
    assert cli._public_url(None) == "https://y.ngrok.io"


def test_serve_argv_forwards_public_url_when_set():
    """_serve_argv emits --public-url=<v> (=value form) iff it is set."""
    args = argparse.Namespace(
        topic="t",
        secret="s",
        host="127.0.0.1",
        port=5555,
        idle_timeout=None,
        sweep_interval=None,
        empty_grace=None,
        max_connections=None,
        public_url="https://x.ngrok.io",
    )
    argv = cli._serve_argv(args)
    assert "--public-url=https://x.ngrok.io" in argv


def test_serve_argv_omits_public_url_when_unset():
    """An unset --public-url is omitted so the child resolves env/None."""
    args = argparse.Namespace(
        topic="t",
        secret="s",
        host="127.0.0.1",
        port=5555,
        idle_timeout=None,
        sweep_interval=None,
        empty_grace=None,
        max_connections=None,
        public_url=None,
    )
    argv = cli._serve_argv(args)
    assert not any(a.startswith("--public-url") for a in argv)


def _serve_args(**overrides) -> argparse.Namespace:
    """A serve args Namespace mirroring the parser defaults; override per test."""
    base = dict(
        topic="t",
        secret="s",
        host="127.0.0.1",
        port=0,
        wait_default=30,
        wait_max=60,
        idle_timeout=None,
        sweep_interval=None,
        empty_grace=None,
        max_connections=None,
        public_url=None,
    )
    base.update(overrides)
    return argparse.Namespace(**base)


def test_cmd_serve_rejects_malformed_public_url(state_dir, monkeypatch, capsys):
    """A public_url with no http(s) scheme makes _cmd_serve exit 1 before boot.

    The flag is resolved by _public_url, then validated in _cmd_serve. It never
    reaches uvicorn.run — pin it to fail loudly if the early return regresses.
    """
    monkeypatch.delenv("WIRE_PUBLIC_URL", raising=False)
    monkeypatch.setattr(
        cli.uvicorn, "run", lambda *a, **k: pytest.fail("reached uvicorn.run on a malformed public_url")
    )
    rc = cli._cmd_serve(_serve_args(public_url="ngrok.io"))  # no scheme
    assert rc == 1
    err = capsys.readouterr().err
    assert "wire: error:" in err and "http://" in err
    # the launch aborted: no state file was written for this bad config
    assert lifecycle.read_state() is None


@pytest.mark.parametrize(
    "max_connections, expected_limit",
    [
        (None, 64),  # unset → resolver applies the Config default (64)
        (1000, 1000),  # explicit flag flows straight through to the cap
        (0, None),  # 0 disables the cap → uvicorn's None ("no limit")
    ],
)
def test_cmd_serve_wires_limit_concurrency(state_dir, monkeypatch, max_connections, expected_limit):
    """_cmd_serve passes limit_concurrency (0 → None) + the keep-alive trim to uvicorn.

    Mocks uvicorn.run so no real port is bound and captures its kwargs — this
    pins the ceiling wiring without exercising uvicorn internals.
    """
    monkeypatch.delenv("WIRE_MAX_CONNECTIONS", raising=False)
    captured = {}
    monkeypatch.setattr(cli.uvicorn, "run", lambda app, **kwargs: captured.update(kwargs))

    rc = cli._cmd_serve(_serve_args(max_connections=max_connections))

    assert rc == 0
    assert captured["limit_concurrency"] == expected_limit
    assert captured["timeout_keep_alive"] == 10


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

WIRE_PKG_DIR = str(Path(lifecycle.__file__).resolve().parent.parent)


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
    auto-gen branch (_cmd_start, cli.py ~L153). Here it omits --secret and
    asserts state carries a generated, non-empty secret (not a passed-in value).
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
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.kill(pid, signal.SIGKILL)
