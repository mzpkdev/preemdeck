"""Operational plumbing for the wire server — the deterministic layer.

This module owns everything the launch/teardown skills used to do in bash:
the on-disk state file (one room per host), LAN-IP detection, the operator
handoff render, and the /health liveness probe. Pure stdlib — no FastAPI, no
pydantic — so it stays unit-testable and the skills shrink to "invoke + relay".

State lives in a single JSON file under the state dir (env ``WIRE_STATE_DIR``,
else ``~/.wire``). The ``wire serve`` process is the single writer of that file;
``wire start`` / ``stop`` / ``status`` only read and clear it.
"""

from __future__ import annotations

import contextlib
import json
import os
import socket
import urllib.error
import urllib.request
from pathlib import Path
from typing import cast

# The one state file, relative to the state dir. One room per host.
_STATE_FILENAME = "wire.json"

# Default teardown / probe timeout for a single /health GET, in seconds.
_HEALTH_TIMEOUT = 2.0


def state_dir() -> Path:
    """Return the state directory, creating it if absent.

    ``WIRE_STATE_DIR`` overrides the default of ``~/.wire`` — tests point it at
    a tmp dir so they never touch a real room's state.
    """
    env = os.environ.get("WIRE_STATE_DIR")
    base = Path(env) if env else Path.home() / ".wire"
    base.mkdir(parents=True, exist_ok=True)
    return base


def state_path() -> Path:
    """Path to the single ``wire.json`` state file."""
    return state_dir() / _STATE_FILENAME


def log_path() -> Path:
    """Path to the detached server's log file (``wire.log``)."""
    return state_dir() / "wire.log"


def write_state(*, pid: int, host: str, port: int, secret: str, url: str, topic: str) -> None:
    """Write the room state file. Called by the ``serve`` process only."""
    payload = {
        "pid": pid,
        "host": host,
        "port": port,
        "secret": secret,
        "url": url,
        "topic": topic,
    }
    state_path().write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def read_state() -> dict | None:
    """Return the parsed state file, or ``None`` if it's absent or unreadable."""
    path = state_path()
    try:
        # json.loads is typed Any; the writer (write_state) always emits a JSON
        # object, so the parsed value is a dict. cast asserts that without
        # changing what is returned.
        return cast("dict | None", json.loads(path.read_text(encoding="utf-8")))
    except (FileNotFoundError, ValueError, OSError):
        return None


def clear_state() -> None:
    """Remove the state file (and the detached log). Idempotent."""
    for path in (state_path(), log_path()):
        with contextlib.suppress(FileNotFoundError):
            path.unlink()


def detect_lan_ip() -> str:
    """Best-effort LAN IP of this host.

    Opens a UDP socket and ``connect``s it to a public address; no packets are
    actually sent, but the kernel picks the source interface, and
    ``getsockname()`` then reveals that interface's address. On any failure
    (no route, sandbox), fall back to loopback.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        # getsockname() returns a tuple typed Any for AF_INET; element 0 is the
        # host string. cast narrows it without touching the value.
        return cast("str", sock.getsockname()[0])
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def render_handoff(url: str, secret: str) -> str:
    """Render the operator handoff block.

    The fenced ``bash`` block holds a literal instruction for a *peer* agent —
    it is printed, never executed. ``url`` and ``secret`` are substituted live.
    """
    return (
        "Send this prompt to your other agents:\n"
        "```bash\n"
        f'Execute `curl -s "{url}/shard?secret={secret}"`, '
        "then follow the instructions there as written.\n"
        "```"
    )


def health_ok(host: str, port: int, timeout: float = _HEALTH_TIMEOUT) -> bool:
    """True iff ``GET http://host:port/health`` returns ``{"status":"ok"}``.

    A dead room can't answer, so any connection error reads as down. The probe
    targets loopback semantics: callers pass the bind host (``127.0.0.1`` in
    tests) or ``127.0.0.1`` for a ``0.0.0.0`` bind.
    """
    probe_host = "127.0.0.1" if host in ("", "0.0.0.0") else host
    url = f"http://{probe_host}:{port}/health"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
    except (urllib.error.URLError, OSError, ValueError):
        return False
    try:
        # `==` against Any is typed Any; the comparison is already a bool at
        # runtime, so bool() is a typing no-op that yields the declared type.
        return bool(json.loads(body) == {"status": "ok"})
    except ValueError:
        return False
