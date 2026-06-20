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


def _start_timeout() -> float:
    """Seconds `start` waits for the detached server to come up.

    The detached child is a *fresh* interpreter: it must import uvicorn +
    FastAPI + the app, bind a port, write state, and spin up the event loop
    before /health answers. On an idle box that is well under a second, but on
    a loaded one (e.g. a CI box running the rest of the suite, or a busy dev
    machine) the child is starved and the same work can take many seconds. The
    bound therefore has to be generous, not tight, so a slow-to-wake — but
    perfectly healthy — child is not mistaken for a dead one. ``WIRE_START_TIMEOUT``
    lets an operator on an especially slow box extend it further without a code
    change; anything unparseable or non-positive falls back to the default.
    """
    raw = os.environ.get("WIRE_START_TIMEOUT")
    if raw is not None:
        try:
            val = float(raw)
            if val > 0:
                return val
        except ValueError:
            pass
    return _START_TIMEOUT_DEFAULT


# Generous default: tolerant of a loaded machine where the detached child's
# cold import + bind is slow. Happy path is unaffected — `start` returns the
# instant BOTH the pid-matching state file and /health are ready.
_START_TIMEOUT_DEFAULT = 30.0
_START_POLL_INTERVAL = 0.2


def _idle_timeout(flag: int | None) -> int:
    """Resolve the idle-drop timeout: flag > ``WIRE_IDLE_TIMEOUT`` env > default.

    Mirrors the ``WIRE_START_TIMEOUT`` precedent (see :func:`_start_timeout`):
    an explicit flag wins; otherwise the env var is consulted; otherwise the
    Config default. Unlike the start timeout, 0 is a MEANINGFUL value here (it
    disables idle drop), so the env accepts any non-negative int — only a
    negative or unparseable value falls through to the default.
    """
    if flag is not None:
        return flag
    raw = os.environ.get("WIRE_IDLE_TIMEOUT")
    if raw is not None:
        try:
            val = int(raw)
            if val >= 0:
                return val
        except ValueError:
            pass
    return Config.idle_timeout


def _empty_grace(flag: int | None) -> int:
    """Resolve the empty-room grace: flag > ``WIRE_EMPTY_GRACE`` env > default.

    Mirrors :func:`_idle_timeout`: an explicit flag wins; otherwise the env var
    is consulted; otherwise the Config default. As with idle drop, 0 is a
    MEANINGFUL value here (it disables empty-room self-close), so the env accepts
    any non-negative int — only a negative or unparseable value falls through to
    the default.
    """
    if flag is not None:
        return flag
    raw = os.environ.get("WIRE_EMPTY_GRACE")
    if raw is not None:
        try:
            val = int(raw)
            if val >= 0:
                return val
        except ValueError:
            pass
    return Config.empty_grace


def _max_connections(flag: int | None) -> int:
    """Resolve the connection cap: flag > ``WIRE_MAX_CONNECTIONS`` env > default.

    Mirrors :func:`_idle_timeout`: an explicit flag wins; otherwise the env var
    is consulted; otherwise the Config default. As with idle drop, 0 is a
    MEANINGFUL value here (it disables the cap → unlimited), so the env accepts
    any non-negative int — only a negative or unparseable value falls through to
    the default.
    """
    if flag is not None:
        return flag
    raw = os.environ.get("WIRE_MAX_CONNECTIONS")
    if raw is not None:
        try:
            val = int(raw)
            if val >= 0:
                return val
        except ValueError:
            pass
    return Config.max_connections


def _sweep_interval(flag: int | None) -> int:
    """Resolve the sweep interval: flag > ``WIRE_SWEEP_INTERVAL`` env > default.

    Same flag>env>default precedence as :func:`_idle_timeout`. The interval is a
    positive cadence, so the env requires ``> 0``; anything else falls back to
    the Config default.
    """
    if flag is not None:
        return flag
    raw = os.environ.get("WIRE_SWEEP_INTERVAL")
    if raw is not None:
        try:
            val = int(raw)
            if val > 0:
                return val
        except ValueError:
            pass
    return Config.sweep_interval


def _public_url(flag: str | None) -> str | None:
    """Resolve the public base URL: flag > ``WIRE_PUBLIC_URL`` env > None.

    Mirrors :func:`_empty_grace` (flag beats env beats default) but the default
    is None — with neither set, wire emits the request/LAN base as it does today.
    The chosen value is normalized: a trailing ``/`` is stripped so callers can
    pass ``https://x.ngrok.io/`` or ``https://x.ngrok.io`` interchangeably.

    NOTE: this does NOT validate the scheme — that check lives in
    :func:`_cmd_serve`, which can fail the launch cleanly (return 1). Returning
    the raw-but-stripped value here keeps the resolver a pure precedence helper.
    """
    value = flag if flag is not None else os.environ.get("WIRE_PUBLIC_URL")
    if value is None:
        return None
    return value.rstrip("/")


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
    secret = args.secret if args.secret is not None else secrets.token_hex(4)

    try:
        port = _find_free_port(args.host, args.port)
    except RuntimeError as exc:
        print(f"wire: error: {exc}", file=sys.stderr)
        return 1

    idle_timeout = _idle_timeout(args.idle_timeout)
    sweep_interval = _sweep_interval(args.sweep_interval)
    empty_grace = _empty_grace(args.empty_grace)
    max_connections = _max_connections(args.max_connections)
    public_url = _public_url(args.public_url)

    # A declared public URL must be a real http(s) base; a malformed value would
    # hand peers an unusable URL, so fail the launch cleanly (same style as the
    # idle-timeout validation above) rather than booting with a broken base.
    if public_url is not None and not public_url.startswith(("http://", "https://")):
        print(
            f"wire: error: --public-url ({public_url}) must start with http:// or https:// "
            "(env WIRE_PUBLIC_URL); it's the public base peers read, so it has to be a full URL.",
            file=sys.stderr,
        )
        return 1

    # Room.__init__ asserts idle_timeout > wait_max (a parked /recv holds a peer
    # silent up to wait_max); pre-validate here so a bad config exits cleanly
    # instead of crashing boot with a raw AssertionError. 0 (disabled) is fine.
    if idle_timeout > 0 and idle_timeout <= args.wait_max:
        print(
            f"wire: error: --idle-timeout ({idle_timeout}) must be greater than "
            f"--wait-max ({args.wait_max}); a parked /recv can hold a peer silent up to "
            "wait_max and would otherwise be reaped mid-poll (use --idle-timeout=0 to disable idle drop).",
            file=sys.stderr,
        )
        return 1

    config = Config(
        host=args.host,
        port=port,
        secret=secret,
        topic=args.topic,
        wait_default=args.wait_default,
        wait_max=args.wait_max,
        public_url=public_url,
        idle_timeout=idle_timeout,
        sweep_interval=sweep_interval,
        empty_grace=empty_grace,
        max_connections=max_connections,
    )

    app = create_app(config)

    # The declared public URL (e.g. a tunnel) wins for both the state file and
    # the handoff banner; with none set, fall back to the LAN base as before.
    urlhost = lifecycle.detect_lan_ip() if config.host in ("", "0.0.0.0") else config.host
    url = public_url or f"http://{urlhost}:{port}"

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

    # limit_concurrency caps simultaneous connections (excess → 503) to bound the
    # unauthenticated-flood blast radius; 0 → None = uvicorn's "no limit". The
    # keep-alive timeout trims slow-loris holds on otherwise-idle connections.
    uvicorn.run(
        app,
        host=config.host,
        port=config.port,
        limit_concurrency=(config.max_connections or None),
        timeout_keep_alive=10,
    )
    return 0


# -- wire start -----------------------------------------------------------


def _serve_argv(args: argparse.Namespace) -> list[str]:
    """Build the ``python -m wire serve …`` argv for the detached child.

    Value-bearing options are emitted in the ``--opt=value`` form, NOT as two
    tokens ``--opt value``. This matters because a value can legitimately begin
    with a dash — e.g. an operator-supplied ``--secret`` (free-form, so it may
    start with one). As two tokens, the child's argparse would read that
    leading-dash value as a *new option* ("expected one argument") and the serve
    process would die before it ever bound — surfacing to `start` as a spurious
    "failed to come up". The ``--opt=value`` form binds the value unambiguously
    regardless of its first character. (The auto-minted secret is
    ``secrets.token_hex(4)`` — 8 lowercase hex chars, never dash-leading — but
    the override path still needs this, so the form is kept.)
    """
    argv = [
        sys.executable,
        "-m",
        "wire",
        "serve",
        f"--topic={args.topic}",
        f"--secret={args.secret}",
        f"--host={args.host}",
        f"--port={args.port}",
    ]
    # Idle-drop, empty-grace and connection-cap knobs are forwarded only when
    # EXPLICITLY set on the parent (flag default is None). An unset flag is
    # omitted so the child still resolves its own
    # WIRE_IDLE_TIMEOUT/WIRE_SWEEP_INTERVAL/WIRE_EMPTY_GRACE/WIRE_MAX_CONNECTIONS
    # env (inherited by the subprocess) or the Config default — preserving the
    # flag>env>default precedence end to end.
    if args.idle_timeout is not None:
        argv.append(f"--idle-timeout={args.idle_timeout}")
    if args.sweep_interval is not None:
        argv.append(f"--sweep-interval={args.sweep_interval}")
    if args.empty_grace is not None:
        argv.append(f"--empty-grace={args.empty_grace}")
    if args.max_connections is not None:
        argv.append(f"--max-connections={args.max_connections}")
    # public_url forwarded only when EXPLICITLY set (flag default None) — an
    # unset flag is omitted so the child resolves its own WIRE_PUBLIC_URL env
    # (or None), preserving flag>env>None precedence end to end.
    if args.public_url is not None:
        argv.append(f"--public-url={args.public_url}")
    return argv


def _cmd_start(args: argparse.Namespace) -> int:
    """Orchestrate: reuse a live room, else spawn the server detached."""
    # Idempotent: a live room already on disk → re-print its handoff, don't respawn.
    existing = lifecycle.read_state()
    if existing is not None and lifecycle.health_ok(existing["host"], existing["port"]):
        print(lifecycle.render_handoff(existing["url"], existing["secret"]))
        return 0

    # Stale state (file present, nothing answering) is harmless — serve overwrites it.
    if args.secret is None:
        args.secret = secrets.token_hex(4)

    log = lifecycle.log_path()
    with open(log, "wb") as logfile:
        child = subprocess.Popen(
            _serve_argv(args),
            stdout=logfile,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    # Poll until the serve process has written state AND /health answers. We
    # only stop early if the child *actually exits* (poll() is not None); a
    # transient — state not written yet, a /health probe that refuses or times
    # out while the child is still booting — just means "not ready yet", so we
    # keep polling within the (generous) deadline rather than bailing on it.
    deadline = time.monotonic() + _start_timeout()
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
    """Build the argparse parser and wire up the four subcommands."""
    parser = argparse.ArgumentParser(
        prog="wire",
        description="Run and manage a WIRE_V3 chat room for LLMs.",
        # RawDescription so the epilog renders verbatim — argparse reflows otherwise.
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            '  wire start --topic "triaging the prod incident"   # spawn detached, print the peer handoff\n'
            "  wire status                                        # is the room up? show its address + secret\n"
            "  wire stop                                          # shut the room down\n"
            "\n"
            "Usual entry point is `start`; `serve` runs the same server in the foreground for debugging."
        ),
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def _add_launch_args(p: argparse.ArgumentParser) -> None:
        """Attach the launch flags shared by both ``serve`` and ``start``."""
        p.add_argument("--topic", required=True, help="conversation topic, handed to peers on /jackin")
        p.add_argument(
            "--secret",
            default=None,
            help="key gating /shard and /jackin; if omitted, a short 8-hex-char one is auto-generated",
        )
        p.add_argument("--host", default="0.0.0.0", help="address the HTTP layer binds to (default: 0.0.0.0)")
        p.add_argument("--port", type=int, default=5555, help="starting port for the free-port scan (default: 5555)")
        # Idle-drop knobs default to None (NOT the Config value) so the resolver
        # can tell "unset" from "set to the default" and apply flag>env>default;
        # `start` forwards them to the detached child only when explicitly set.
        p.add_argument(
            "--idle-timeout",
            type=int,
            default=None,
            help="seconds of silence before a peer is dropped; 0 disables (env WIRE_IDLE_TIMEOUT, default: 300). Must exceed --wait-max when > 0.",
        )
        p.add_argument(
            "--sweep-interval",
            type=int,
            default=None,
            help="seconds between idle sweeps (env WIRE_SWEEP_INTERVAL, default: 15)",
        )
        p.add_argument(
            "--empty-grace",
            type=int,
            default=None,
            help="seconds an empty roster is tolerated before the server self-closes; 0 disables (env WIRE_EMPTY_GRACE, default: 900 = 15 min).",
        )
        p.add_argument(
            "--max-connections",
            type=int,
            default=None,
            help="max concurrent connections before returning 503; 0 = unlimited (env WIRE_MAX_CONNECTIONS, default: 64).",
        )
        # Default None so the resolver can tell "unset" from a value and apply
        # flag>env>None; `start` forwards it to the child only when explicitly set.
        p.add_argument(
            "--public-url",
            default=None,
            help="public base URL peers read (e.g. behind a tunnel: https://x.ngrok.io); must start with http:// or https:// (env WIRE_PUBLIC_URL). Unset = use the request/LAN base.",
        )

    p_serve = sub.add_parser(
        "serve",
        help="run the server in the foreground (blocking)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=('Example:\n  wire serve --topic "triaging the prod incident"'),
    )
    _add_launch_args(p_serve)
    p_serve.add_argument("--wait-default", type=int, default=30, help="seconds a quiet /recv parks (default: 30)")
    p_serve.add_argument("--wait-max", type=int, default=60, help="server-side clamp on a caller wait (default: 60)")
    p_serve.set_defaults(func=_cmd_serve)

    p_start = sub.add_parser(
        "start",
        help="spawn the server detached and print the operator handoff",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            '  wire start --topic "triaging the prod incident"\n'
            '  wire start --topic "triaging the prod incident" --public-url https://x.ngrok.io   # behind a tunnel'
        ),
    )
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
