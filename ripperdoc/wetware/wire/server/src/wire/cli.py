"""The ``wire`` command surface: a subcommand dispatcher.

Four subcommands, one ``main()``:

* ``wire serve`` — the FOREGROUND server. Resolves a free port, builds the
  frozen :class:`~wire.config.Config`, writes the state file (it is the single
  writer), prints the ``wire: ready`` banner, and runs uvicorn (blocking).
* ``wire start`` — the ORCHESTRATOR. Idempotent: if a room is already up it
  re-prints the handoff. Otherwise it spawns ``wire serve`` DETACHED, waits for
  it to come up, and prints the operator handoff.
* ``wire stop`` — TERM/KILL the tracked pid, confirm it's down, clear state.
* ``wire status`` — read state + probe /health, report up/down.

The deterministic plumbing (state file, LAN-IP, handoff, health) lives in
:mod:`wire.lifecycle`; this module is just argparse + process control.
"""

from __future__ import annotations

import argparse
import os
import secrets
import signal
import socket
import subprocess
import sys
import time

import uvicorn

from . import lifecycle
from .app import create_app
from .config import Config

# How many consecutive ports to probe from the start port before giving up.
_PORT_SCAN_ATTEMPTS = 100

# Bound on how long `start` waits for the detached server to come up, seconds.
_START_TIMEOUT = 10.0
_START_POLL_INTERVAL = 0.2

# Bound on how long `stop` waits for a TERM'd process to exit, seconds.
_STOP_TIMEOUT = 5.0
_STOP_POLL_INTERVAL = 0.2


def _find_free_port(host: str, start: int, attempts: int = _PORT_SCAN_ATTEMPTS) -> int:
    """Return the first bindable port at/above ``start``, scanning upward.

    Probes each port by binding a throwaway socket to ``(host, port)``; a busy
    port raises ``OSError`` and we advance by one. The probe socket is closed
    before returning, so a brief bind race remains (acceptable for LAN use).
    Raises ``RuntimeError`` if no free port is found within ``attempts``.
    """
    for port in range(start, start + attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind((host, port))
            except OSError:
                continue
            return port
    raise RuntimeError(f"no free port in range {start}-{start + attempts - 1} on {host}")


def _pid_alive(pid: int) -> bool:
    """True if a signal can be delivered to ``pid`` (the process exists)."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


# -- wire serve -----------------------------------------------------------


def _cmd_serve(args: argparse.Namespace) -> int:
    """Run the foreground server: resolve port, write state, run uvicorn."""
    secret = args.secret if args.secret is not None else secrets.token_urlsafe(16)

    try:
        port = _find_free_port(args.host, args.port)
    except RuntimeError as exc:
        print(f"wire: error: {exc}", file=sys.stderr)
        return 1

    config = Config(
        host=args.host,
        port=port,
        secret=secret,
        topic=args.topic,
        wait_default=args.wait_default,
        wait_max=args.wait_max,
    )

    app = create_app(config)

    urlhost = lifecycle.detect_lan_ip() if config.host in ("", "0.0.0.0") else config.host
    url = f"http://{urlhost}:{port}"

    # The serve process is the single writer of the state file.
    lifecycle.write_state(
        pid=os.getpid(),
        host=config.host,
        port=config.port,
        secret=config.secret,
        url=url,
        topic=config.topic,
    )

    # Stable, greppable startup banner. KEEP THIS SHAPE STABLE.
    print(
        f"wire: ready host={config.host} port={config.port} pid={os.getpid()} secret={config.secret}",
        flush=True,
    )

    uvicorn.run(app, host=config.host, port=config.port)
    return 0


# -- wire start -----------------------------------------------------------


def _serve_argv(args: argparse.Namespace) -> list[str]:
    """Build the ``python -m wire serve …`` argv for the detached child."""
    return [
        sys.executable,
        "-m",
        "wire",
        "serve",
        "--topic",
        args.topic,
        "--secret",
        args.secret,
        "--host",
        args.host,
        "--port",
        str(args.port),
    ]


def _cmd_start(args: argparse.Namespace) -> int:
    """Orchestrate: reuse a live room, else spawn the server detached."""
    # Idempotent: a live room already on disk → re-print its handoff, don't respawn.
    existing = lifecycle.read_state()
    if existing is not None and lifecycle.health_ok(existing["host"], existing["port"]):
        print(lifecycle.render_handoff(existing["url"], existing["secret"]))
        return 0

    # Stale state (file present, nothing answering) is harmless — serve overwrites it.
    if args.secret is None:
        args.secret = secrets.token_urlsafe(16)

    log = lifecycle.log_path()
    with open(log, "wb") as logfile:
        child = subprocess.Popen(
            _serve_argv(args),
            stdout=logfile,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    # Poll until the serve process has written state AND /health answers.
    deadline = time.monotonic() + _START_TIMEOUT
    while time.monotonic() < deadline:
        state = lifecycle.read_state()
        if state is not None and state.get("pid") == child.pid and lifecycle.health_ok(state["host"], state["port"]):
            print(lifecycle.render_handoff(state["url"], state["secret"]))
            return 0
        if child.poll() is not None:
            break  # child died early — stop waiting, report below
        time.sleep(_START_POLL_INTERVAL)

    # Timed out or the child exited. Report the log tail, ensure the child is dead.
    print("wire: error: server failed to come up", file=sys.stderr)
    try:
        tail = log.read_text(encoding="utf-8", errors="replace").splitlines()[-30:]
        if tail:
            print("--- wire.log tail ---", file=sys.stderr)
            print("\n".join(tail), file=sys.stderr)
    except OSError:
        pass
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            child.kill()
    return 1


# -- wire stop ------------------------------------------------------------


def _cmd_stop(_args: argparse.Namespace) -> int:
    """TERM/KILL the tracked room, confirm it's down, clear state."""
    state = lifecycle.read_state()
    if state is None:
        print("wire: nothing running")
        return 0

    pid = state["pid"]
    port = state["port"]
    host = state["host"]

    if not _pid_alive(pid):
        lifecycle.clear_state()
        print(f"wire: stale state cleared (pid {pid} not running, port {port}).")
        return 0

    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + _STOP_TIMEOUT
    while time.monotonic() < deadline and _pid_alive(pid):
        time.sleep(_STOP_POLL_INTERVAL)

    killed_hard = False
    if _pid_alive(pid):
        os.kill(pid, signal.SIGKILL)
        killed_hard = True
        time.sleep(0.5)

    lifecycle.clear_state()

    if lifecycle.health_ok(host, port):
        print(f"wire: WARN — /health on port {port} still answering after stop.", file=sys.stderr)
        return 1

    how = "SIGKILL" if killed_hard else "SIGTERM"
    print(f"wire: stopped (pid {pid}, port {port}, via {how}); state cleared.")
    return 0


# -- wire status ----------------------------------------------------------


def _cmd_status(_args: argparse.Namespace) -> int:
    """Report the tracked room's address + secret and whether it's up."""
    state = lifecycle.read_state()
    if state is None:
        print("wire: not running")
        return 0

    up = lifecycle.health_ok(state["host"], state["port"])
    status = "up" if up else "down"
    print(
        f"wire: {status}\n"
        f"  host:   {state['host']}\n"
        f"  port:   {state['port']}\n"
        f"  url:    {state['url']}\n"
        f"  secret: {state['secret']}"
    )
    return 0


# -- dispatch -------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="wire",
        description="Run and manage a WIRE_V3 chat room for LLMs.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def _add_launch_args(p: argparse.ArgumentParser) -> None:
        p.add_argument("--topic", required=True, help="conversation topic, handed to peers on /jackin")
        p.add_argument("--secret", default=None, help="key gating /shard and /jackin; auto-generated if omitted")
        p.add_argument("--host", default="0.0.0.0", help="address the HTTP layer binds to (default: 0.0.0.0)")
        p.add_argument("--port", type=int, default=5555, help="starting port for the free-port scan (default: 5555)")

    p_serve = sub.add_parser("serve", help="run the server in the foreground (blocking)")
    _add_launch_args(p_serve)
    p_serve.add_argument("--wait-default", type=int, default=30, help="seconds a quiet /recv parks (default: 30)")
    p_serve.add_argument("--wait-max", type=int, default=60, help="server-side clamp on a caller wait (default: 60)")
    p_serve.set_defaults(func=_cmd_serve)

    p_start = sub.add_parser("start", help="spawn the server detached and print the operator handoff")
    _add_launch_args(p_start)
    p_start.set_defaults(func=_cmd_start)

    p_stop = sub.add_parser("stop", help="stop the tracked server and clear its state")
    p_stop.set_defaults(func=_cmd_stop)

    p_status = sub.add_parser("status", help="report whether the tracked server is up")
    p_status.set_defaults(func=_cmd_status)

    return parser


def main() -> None:
    """The ``wire`` console entry-point. Parse, dispatch, exit with the code."""
    parser = _build_parser()
    args = parser.parse_args()
    raise SystemExit(args.func(args))


if __name__ == "__main__":
    main()
