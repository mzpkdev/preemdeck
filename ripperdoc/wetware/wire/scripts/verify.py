#!/usr/bin/env python3
"""
verify.py - end-to-end localhost proof for the wire relay.

Spins up relay.py on a private test port, runs fake agents against it EXACTLY as
a real agent would (jack -> parse manual -> recv/send loop -> unplug), and
captures transcripts to ./transcripts/. There are NO rooms: one relay process ==
one conversation, and the process EXITS when the conversation closes. So each
scenario gets its OWN relay process on its OWN port.

  PROOF 1 (group exchange): 3 agents cooperatively count to a target; the agent
           that reaches it announces done and leaves; the others see the
           departure and leave too. When the last peer leaves the relay closes
           and the process exits. Proves group fanout, long-poll wake, a clean
           leave/close cascade, and process-exit-on-empty.

  PROOF 2 (safety): agents that never stop, with the turn cap set low (6). The
           relay must force-close (and exit). A second variant proves the
           repetition-kill; a third proves parked /recv release on close.

  PROOF 3 (backlog-on-jack): a peer that jacks in AFTER an earlier post must get
           that post on its FIRST scan (the late-joiner-catches-up case).

  PROOF 4 (topic brief): a relay launched with --brief seeds the topic as the
           seq-1 system entry; a fresh peer's FIRST scan returns it at the top,
           and the /jack manual shows it in a TOPIC block. Proves the brief
           survives argv -> log -> /recv JSON (multiline) and reaches peers first.

  PROOF 5 (soft gate): the shared-secret ?k= gate rejects a gated route (/trace,
           /jack, /recv) with NO key and with a WRONG key (HTTP 401) and allows
           it with the RIGHT key (200), while /health stays OPEN. Guards the old
           "anyone reads /trace / mints a token" hole.

Every test relay runs with a known secret (RELAY_SECRET, pinned in start_relay);
the harness carries it on every gated URL (via _k()) and to fake agents (via
--secret), so all proofs run WITH the gate on. PROOF 5 deliberately omits/wrongs
the key to prove the 401.

Run:  python3 verify.py
Pure stdlib. Starts/stops its own relays; leaves no pids or stray processes.
"""

import contextlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, TextIO

HERE = Path(__file__).resolve().parent
RELAY = str(HERE / "relay.py")
AGENT = str(HERE / "fake_agent.py")
TDIR = str(HERE.parent / "transcripts")  # wire/transcripts/

# ---------------------------------------------------------------------------
# Timeouts + a hard wall-clock WATCHDOG. The whole point of this proof is that
# it can NEVER hang: a regression in the relay's close path once wedged the
# safety run for ~18 minutes on zombie long-polls. So:
#   * every HTTP call here uses a SHORT timeout (HTTP_TIMEOUT),
#   * every child process is registered and waited on with a SHORT timeout,
#   * a daemon watchdog kills the relay + ALL children and force-exits with
#     PARTIAL/TIMEOUT if the whole run exceeds WATCHDOG_SECONDS.
# There is no unbounded wait anywhere in this file or the fake agents' paths.
# ---------------------------------------------------------------------------
HTTP_TIMEOUT = 5  # seconds, every urllib call in the test path
AGENT_WAIT = 20  # seconds, max we wait on any single agent process
WATCHDOG_SECONDS = 90  # hard ceiling on the ENTIRE verify run

# The shared SOFT-GATE secret every test relay runs with. start_relay() pins it
# via RELAY_SECRET so the harness knows the key deterministically (no need to read
# each relay's .relay.secret back). Every gated URL the harness builds carries it
# via _k(); fake agents get it via --secret. proof_gate() deliberately omits/wrongs
# it to prove the 401. A FIXED known value keeps the proofs reproducible.
VERIFY_SECRET = "verify-secret-key"


def _k(url: str) -> str:
    """Append the shared access key (?k= / &k=) to a gated URL. Picks the right
    separator based on whether the URL already has a query string. /health is the
    one open route and must NOT be wrapped."""
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}k={VERIFY_SECRET}"


# Every Popen we create is tracked here so the watchdog can reap them all.
_PROCS: list[subprocess.Popen[str]] = []
_PROCS_LOCK = threading.Lock()


def _register(proc: subprocess.Popen[str]) -> subprocess.Popen[str]:
    with _PROCS_LOCK:
        _PROCS.append(proc)
    return proc


def _kill_all() -> None:
    """Terminate, then hard-kill, every process we ever started."""
    with _PROCS_LOCK:
        procs = list(_PROCS)
    for p in procs:
        with contextlib.suppress(Exception):
            if p.poll() is None:
                p.terminate()
    deadline = time.time() + 3
    for p in procs:
        try:
            p.wait(timeout=max(0.0, deadline - time.time()))
        except Exception:
            with contextlib.suppress(Exception):
                p.kill()


def _start_watchdog() -> threading.Thread:
    """Daemon thread: if the run overruns, reap everything and exit nonzero.

    Uses os._exit so a child stuck in a C-level read can't keep us alive."""

    def _bark() -> None:
        time.sleep(WATCHDOG_SECONDS)
        sys.stderr.write(
            f"\nPARTIAL/TIMEOUT: verify exceeded {WATCHDOG_SECONDS}s wall clock "
            f"-- killing relay + all child procs and aborting.\n"
        )
        sys.stderr.flush()
        _kill_all()
        os._exit(124)  # 124 == conventional "timed out"

    t = threading.Thread(target=_bark, name="verify-watchdog", daemon=True)
    t.start()
    return t


def get(url: str, timeout: float = HTTP_TIMEOUT) -> tuple[int, str]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, str(e)


def wait_health(base: str, tries: int = 50) -> bool:
    for _ in range(tries):
        status, _ = get(base + "/health", timeout=1)
        if status == 200:
            return True
        time.sleep(0.1)
    return False


def start_relay(
    tag: str,
    env_overrides: dict[str, str],
    extra_args: list[str] | None = None,
    room: str | None = None,
    statedir: str | None = None,
    wait_port: bool = True,
) -> tuple[subprocess.Popen[str], str | None]:
    """Start a test relay bound to an OS-assigned FREE port (RELAY_PORT=0). We
    read the actually-bound port back from the relay's own portfile, so the
    auto-scan bind logic stays deterministic in the harness -- no fixed port can
    collide, and we never depend on a guess. Returns (proc, base_url).

    `tag` only names the per-relay pid/port files in tmp so concurrent test
    relays never clobber the real plugin files (wire/.relay.pid / .relay.port) or
    each other.

    `extra_args` (optional) are appended verbatim to the relay's argv -- used by
    the brief proof to pass `--brief "<multiline>"` on the command line, the same
    launch path /uplink uses. Host/port still come via env (RELAY_HOST/PORT), and
    relay.py strips --brief before its positional parse, so the two don't collide.

    ROOM MODE (`room` set): instead of pinning the three per-file RELAY_*FILE
    overrides, we set RELAY_STATEDIR to `statedir` (a per-test tmp dir) and pass
    `--room <room>` on argv, so relay.py's room derivation + infix logic runs FOR
    REAL -- writing `.relay.<room>.{pid,port,secret}` inside that dir. The portfile
    we read back is computed the same way. This keeps the room proofs OUT of the
    real wire/ dir while exercising the actual code path /uplink uses. The legacy
    per-file-override mode (room=None) is unchanged, so the existing proofs keep
    their isolation exactly as before.

    `wait_port=False` skips the portfile-readback wait -- used by the lock proof,
    whose second relay is EXPECTED to refuse and never write a portfile."""
    extra = list(extra_args or [])
    env = dict(os.environ)
    env["RELAY_HOST"] = "127.0.0.1"
    env["RELAY_PORT"] = "0"  # OS picks a free port; we read it back from the portfile
    # Pin the soft-gate secret to a known value so the harness knows the key
    # deterministically (the room proofs don't read each relay's secret back).
    env["RELAY_SECRET"] = VERIFY_SECRET

    if room is not None:
        # Exercise the REAL room path: a per-test statedir + --room, files infixed.
        if statedir is None:
            raise ValueError("room mode requires a statedir")
        env["RELAY_STATEDIR"] = statedir
        # Make sure no stray per-file override leaks in from the parent env and
        # defeats the STATEDIR+infix resolution we are trying to prove.
        for k in ("RELAY_PIDFILE", "RELAY_PORTFILE", "RELAY_SECRETFILE"):
            env.pop(k, None)
        portfile = str(Path(statedir) / f".relay.{room}.port")
        extra = ["--room", room, *extra]
    else:
        # Legacy isolation: pin the three state files to tmp so concurrent test
        # relays never clobber the real plugin files or each other.
        tmp = Path(tempfile.gettempdir())
        portfile = str(tmp / f"wire-verify-{tag}.port")
        env["RELAY_PIDFILE"] = str(tmp / f"wire-verify-{tag}.pid")
        env["RELAY_PORTFILE"] = portfile
        env["RELAY_SECRETFILE"] = str(tmp / f"wire-verify-{tag}.secret")
    # stale file from a prior run would mislead the readback
    with contextlib.suppress(OSError):
        Path(portfile).unlink()
    env.update(env_overrides)
    # Capture relay stdout so we can show jack/unplug/close log lines if needed.
    argv = [sys.executable, RELAY, *extra]
    proc = subprocess.Popen(
        argv,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    _register(proc)
    if not wait_port:
        return proc, None
    # Read the bound port back from the portfile (bounded wait -- never block).
    port = None
    for _ in range(50):  # ~5s max
        try:
            with Path(portfile).open() as f:
                txt = f.read().strip()
            if txt:
                port = int(txt)
                break
        except (OSError, ValueError):
            pass
        time.sleep(0.1)
    if port is None:
        raise RuntimeError(f"relay [{tag}] never wrote its portfile {portfile}")
    return proc, f"http://127.0.0.1:{port}"


def stop_relay(proc: subprocess.Popen[str]) -> None:
    """Stop a relay. It may have ALREADY self-exited (close -> process exit);
    that's expected and fine -- terminate() on a dead proc is a no-op."""
    if proc.poll() is None:
        proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


def run_agents(specs: list[list[str]], base: str) -> list[str]:
    """Launch agents (list of arg lists), capture each one's stdout, wait.

    Each agent is waited on with a SHORT per-process timeout (AGENT_WAIT). If
    an agent does not exit in time it is killed and its output is tagged
    <<KILLED: did not exit>> -- so one stuck agent can never wedge the run.
    (The global watchdog is the ultimate backstop above this.)"""
    procs = []
    for spec in specs:
        # --secret rides every fake agent: /jack itself is gated, so the agent
        # needs the key before it can fetch the manual.
        p = subprocess.Popen(
            [sys.executable, AGENT, "--base", base, "--secret", VERIFY_SECRET, *spec],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        _register(p)
        procs.append(p)
        time.sleep(0.25)  # tiny stagger so handles come out peer-1,2,3 in order
    outs = []
    for p in procs:
        try:
            out, _ = p.communicate(timeout=AGENT_WAIT)
        except subprocess.TimeoutExpired:
            p.kill()
            try:
                out, _ = p.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                out = ""
            out = (out or "") + "\n<<KILLED: agent did not exit within "
            out += f"{AGENT_WAIT}s -- relay close path may have hung a scan>>\n"
        outs.append(out)
    return outs


def banner(fh: TextIO, title: str) -> None:
    line = "=" * 72
    print(line)
    print(title)
    print(line)
    fh.write(line + "\n" + title + "\n" + line + "\n")


def join_token(base: str, timeout: float = HTTP_TIMEOUT) -> str:
    """Jack in (key on the URL -- /jack is gated) and scrape the token out of the
    manual, exactly like an agent. Returns the opaque token (or raises)."""
    status, manual = get(_k(f"{base}/jack"), timeout=timeout)
    m = re.search(r"/recv\?t=([0-9a-f]+)", manual)
    if not m:
        raise RuntimeError(f"jack failed ({status}): {manual[:120]}")
    return m.group(1)


def show_manual(fh: TextIO, topic: str) -> None:
    """Spin up a THROWAWAY relay on its own port purely to capture the /jack
    manual verbatim, then stop it. Doing this against the REAL conversation's
    relay would mint a peer and -- because one relay is one conversation -- a
    later leave/empty would close it; a separate process keeps the real run
    pristine."""
    proc, base = start_relay("manual", {"RELAY_TOPIC": topic, "RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120"})
    assert base is not None
    try:
        if not wait_health(base):
            return
        status, manual = get(_k(f"{base}/jack"), timeout=5)
        banner(fh, f"/jack MANUAL (verbatim, status {status})")
        print(manual)
        fh.write(manual + "\n")
    finally:
        stop_relay(proc)


def park_recv(base: str, token: str, results: dict[int, dict[str, Any]], idx: int) -> None:
    """Park ONE long-poll /recv (asking for the full 600s wait) and record how
    long it actually blocked before returning. Used to PROVE the deadlock fix:
    when the conversation closes, this must return within a moment -- NOT sit
    for the full 600s. The urllib timeout is short (HTTP_TIMEOUT+1) so even a
    true regression frees this thread quickly and shows up as a ~6s elapsed,
    never an 18-minute hang."""
    t0 = time.time()
    status, body = get(_k(f"{base}/recv?t={token}&wait=600"), timeout=HTTP_TIMEOUT + 1)
    results[idx] = {
        "elapsed": round(time.time() - t0, 3),
        "status": status,
        "body": body.strip()[:160],
    }


def proof_group() -> str:
    out_path = str(Path(TDIR) / "proof_group.txt")

    # Generous caps so the natural leave/close -- not a cap -- ends this run.
    proc, base = start_relay("group", {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120"})
    assert base is not None  # wait_port=True always yields a base URL
    with Path(out_path).open("w", buffering=1) as fh:  # line-buffered: flush as we go
        try:
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)

            banner(fh, "PROOF 1 - GROUP EXCHANGE (3 agents, shared log, clean leave/close)")

            # Show the /jack manual verbatim (the UX centerpiece) from a SEPARATE
            # throwaway relay, so previewing it can't perturb the real conversation
            # (a jack + unplug on it would close it and exit its process).
            show_manual(fh, topic="ship the release")

            # Now run THREE real-style agents counting to 6 against the real relay.
            # One is told to open the discussion (--kickoff); the others react.
            # Target small so the exchange is short and readable.
            print("\n--- launching 3 agents (collab, target=6) ---\n")
            fh.write("\n--- launching 3 agents (collab, target=6) ---\n\n")
            # Two responders launch first and park on recv; the kickoff agent
            # launches LAST and posts the opening 'count: 1'. (Cursors now start at
            # the log's START so a joiner gets the full backlog on its first scan --
            # see proof_backlog -- but ordering the opener last keeps this run's
            # transcript clean and readable regardless.)
            specs = [
                ["--mode", "collab", "--target", "6"],
                ["--mode", "collab", "--target", "6"],
                ["--mode", "collab", "--target", "6", "--kickoff"],
            ]
            outs = run_agents(specs, base)
            for i, out in enumerate(outs, 1):
                header = f"\n----- agent process #{i} stdout -----"
                print(header)
                print(out)
                fh.write(header + "\n" + out)

            # The last agent's leave empties the conversation -> relay closes and
            # the process exits (after a short grace). Try to grab /trace while
            # it's still up; if the process already exited, the per-agent stdout
            # above is the authoritative record. Either way we never block.
            status, tx = get(_k(f"{base}/trace"), timeout=2)
            banner(fh, "RELAY TRACE (human watcher view)")
            if status == 200:
                print(tx)
                fh.write(tx + "\n")
            else:
                note = "(relay already exited on empty-conversation close -- see agent stdout above)\n"
                print(note)
                fh.write(note)

            # Confirm the process self-exited on close (the lifecycle==process rule).
            time.sleep(0.6)
            exited = proc.poll() is not None
            verdict = f"\nrelay process self-exited on close: {'YES' if exited else 'NO'} (exit={proc.poll()})\n"
            print(verdict)
            fh.write(verdict)
        finally:
            stop_relay(proc)
    print(f"[saved] {out_path}")
    return out_path


def proof_safety() -> str:
    out_path = str(Path(TDIR) / "proof_safety.txt")

    with Path(out_path).open("w", buffering=1) as fh:  # line-buffered: flush as we go
        # --- 2a: turn cap force-close -------------------------------------
        proc, base = start_relay("turncap", {"RELAY_MAX_TURNS": "6", "RELAY_MAX_SECONDS": "120"})
        assert base is not None
        try:
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)
            banner(fh, "PROOF 2a - TURN CAP (RELAY_MAX_TURNS=6): relay force-closes runaway agents")
            print("\n--- launching 3 spammer agents that never stop (distinct lines) ---\n")
            fh.write("\n--- launching 3 spammer agents that never stop (distinct lines) ---\n\n")
            specs = [["--mode", "spammer", "--max-turns", "6"] for _ in range(3)]
            outs = run_agents(specs, base)
            for i, out in enumerate(outs, 1):
                header = f"\n----- spammer process #{i} stdout -----"
                print(header)
                print(out)
                fh.write(header + "\n" + out)
            # Relay has closed + exited on the cap. Grab the trace if still up.
            status, tx = get(_k(f"{base}/trace"), timeout=2)
            banner(fh, "RELAY TRACE (note the forced close at 6 posts)")
            if status == 200:
                print(tx)
                fh.write(tx + "\n")
            else:
                note = "(relay already exited on turn-cap close -- see agent stdout above)\n"
                print(note)
                fh.write(note)
        finally:
            stop_relay(proc)

        # --- 2b: repetition kill ------------------------------------------
        # High turn cap so ONLY the repetition rule can close it.
        proc, base = start_relay("repeat", {"RELAY_MAX_TURNS": "40", "RELAY_REPEAT_WINDOW": "3"})
        assert base is not None
        try:
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)
            banner(fh, "PROOF 2b - REPETITION KILL (RELAY_REPEAT_WINDOW=3): identical posts close it")
            print("\n--- launching 2 spammer agents posting the IDENTICAL line ---\n")
            fh.write("\n--- launching 2 spammer agents posting the IDENTICAL line ---\n\n")
            specs = [["--mode", "spammer", "--same", "--max-turns", "40"] for _ in range(2)]
            outs = run_agents(specs, base)
            for i, out in enumerate(outs, 1):
                header = f"\n----- spammer process #{i} stdout -----"
                print(header)
                print(out)
                fh.write(header + "\n" + out)
            status, tx = get(_k(f"{base}/trace"), timeout=2)
            banner(fh, "RELAY TRACE (note the 'stalled/repetition' close)")
            if status == 200:
                print(tx)
                fh.write(tx + "\n")
            else:
                note = "(relay already exited on repetition-kill close -- see agent stdout above)\n"
                print(note)
                fh.write(note)
        finally:
            stop_relay(proc)

        # --- 2c: parked scan release on close (THE deadlock fix) ----------
        # This is the regression that wedged the safety run for ~18 minutes: when the
        # conversation closes, every /recv already parked on a long-poll must be
        # released IMMEDIATELY -- it must not block until its own 600s wait expires.
        # Here we park three long-poll scans (each asking for the full 600s), let
        # them settle, then trip the turn cap from a separate writer and measure how
        # long each parked scan actually blocked. They must all return in well under
        # a second carrying the closure signal.
        proc, base = start_relay("parked", {"RELAY_MAX_TURNS": "1", "RELAY_MAX_SECONDS": "120"})
        assert base is not None
        try:
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)
            banner(fh, "PROOF 2c - PARKED-SCAN RELEASE ON CLOSE (the deadlock fix)")
            msg = (
                "Parking 3 long-poll scans (each requesting the full wait=600s), "
                "then a 4th peer trips the turn cap (RELAY_MAX_TURNS=1).\n"
                "Each parked scan MUST return within a moment of close -- not sit "
                "for 600s. Elapsed times below are the proof.\n"
            )
            print(msg)
            fh.write(msg + "\n")

            parkers = [join_token(base) for _ in range(3)]
            writer = join_token(base)
            results: dict[int, dict[str, Any]] = {}
            threads = [
                threading.Thread(target=park_recv, args=(base, tok, results, i)) for i, tok in enumerate(parkers)
            ]
            for t in threads:
                t.start()
            time.sleep(0.5)  # ensure all three are genuinely parked on cond.wait

            # POST the cap-tripping message (a tiny urllib POST). This is the
            # "close moment" -- the parked scans above must be released right after.
            req = urllib.request.Request(_k(f"{base}/send?t={writer}"), data=b"go", method="POST")
            try:
                with urllib.request.urlopen(req, timeout=5) as r:
                    send_status = r.status
            except urllib.error.HTTPError as e:
                send_status = e.code
            line = f"writer send (trips cap) -> HTTP {send_status} (close moment)\n"
            print(line)
            fh.write(line)

            for t in threads:
                t.join(timeout=HTTP_TIMEOUT + 3)

            worst = 0.0
            for i in range(len(parkers)):
                r = results.get(i, {"elapsed": -1, "status": "NO-RESULT(STILL BLOCKED)", "body": ""})
                worst = max(worst, r["elapsed"])
                ln = f"  parked scan #{i + 1}: released after {r['elapsed']}s (status {r['status']}) <- {r['body']}\n"
                print(ln, end="")
                fh.write(ln)

            verdict = f"\nVERDICT: worst parked-scan wake = {worst}s after close. " + (
                "PASS -- no scan outlived close by more than a moment.\n"
                if 0 <= worst < 2.0
                else "FAIL -- a parked scan blocked too long (deadlock not fixed).\n"
            )
            print(verdict)
            fh.write(verdict)

            status, tx = get(_k(f"{base}/trace"), timeout=2)
            banner(fh, "RELAY TRACE (deadlock-check)")
            if status == 200:
                print(tx)
                fh.write(tx + "\n")
            else:
                note = "(relay already exited on close -- expected)\n"
                print(note)
                fh.write(note)
        finally:
            stop_relay(proc)
    print(f"[saved] {out_path}")
    return out_path


def post(base: str, token: str, body: str, timeout: float = HTTP_TIMEOUT) -> tuple[int, str]:
    """Raw POST to /send (a real agent would curl this -- key on the URL since
    /send is gated). Returns (status, text)."""
    req = urllib.request.Request(_k(f"{base}/send?t={token}"), data=body.encode("utf-8"), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, str(e)


def proof_backlog() -> bool:
    """PROOF 3 (backlog-on-jack): peer A jacks in and posts 'hello' BEFORE peer B
    exists. Then B jacks in and its FIRST scan must return that 'hello' -- the
    backlog -- immediately, NOT block/timeout. This is the host-says-hi-then-
    hands-over-the-jack-URL case: a late joiner has to catch up on its first
    read. We use a SHORT bounded wait (wait=2) so even a regression (cursor
    starting at the log's end -> nothing to return) surfaces as a quick 200 idle
    heartbeat, never a hang."""
    out_path = str(Path(TDIR) / "proof_backlog.txt")

    # Generous caps so A's single 'hello' can't trip a close before B reads it.
    # Low idle wait so the bounded "nothing new" scan returns its 200 heartbeat fast.
    proc, base = start_relay("backlog", {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120", "RELAY_IDLE_WAIT": "2"})
    assert base is not None
    passed = False
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)
            banner(fh, "PROOF 3 - BACKLOG ON JACK (late joiner's first scan returns the pre-jack log)")

            # Peer A jacks in and speaks FIRST, before B is anywhere.
            tok_a = join_token(base)
            line = "peer A jacked in and posts 'hello, lets discuss X' (before B exists)\n"
            print(line)
            fh.write(line)
            st, _ = post(base, tok_a, "hello, lets discuss X")
            line = f"  A send -> HTTP {st}\n"
            print(line, end="")
            fh.write(line)

            # NOW peer B jacks in -- strictly after A's post is already on the log.
            tok_b = join_token(base)
            line = "peer B jacked in AFTER A's post; B runs its FIRST scan (wait=2, bounded)\n"
            print(line)
            fh.write(line)

            # B's first scan must hand back the backlog (A's 'hello') right away.
            status, body = get(_k(f"{base}/recv?t={tok_b}&wait=2"), timeout=HTTP_TIMEOUT)
            line = f"  B first scan -> HTTP {status}: {body.strip()[:160]}\n"
            print(line, end="")
            fh.write(line)

            saw_hello = status == 200 and "hello, lets discuss X" in body
            passed = saw_hello
            verdict = (
                "\nVERDICT: B's first scan returned A's pre-jack 'hello'. PASS -- backlog delivered on jack.\n"
                if saw_hello
                else f"\nVERDICT: B's first scan did NOT carry the backlog (status {status}). "
                "FAIL -- late joiner missed pre-jack messages.\n"
            )
            print(verdict)
            fh.write(verdict)

            # Sanity: B's SECOND scan (bounded, nothing new) now returns the 200
            # idle heartbeat -- the cursor advanced past the backlog, so 'hello' is
            # NOT re-delivered; instead we get {"idle": true, ...}.
            status2, body2 = get(_k(f"{base}/recv?t={tok_b}&wait=1"), timeout=HTTP_TIMEOUT)
            idle_ok = status2 == 200 and '"idle": true' in body2 and "hello, lets discuss X" not in body2
            line = (
                f"  B second scan (should be 200 idle, no re-delivery) -> HTTP {status2}: "
                f"{body2.strip()[:120]} [{'OK' if idle_ok else 'FAIL'}]\n"
            )
            print(line, end="")
            fh.write(line)
            passed = passed and idle_ok

            # Leave cleanly so the relay closes and self-exits (no stray process).
            get(_k(f"{base}/unplug?t={tok_a}"), timeout=2)
            get(_k(f"{base}/unplug?t={tok_b}"), timeout=2)
        finally:
            stop_relay(proc)
    print(f"[saved] {out_path}")
    return passed


def proof_idle() -> bool:
    """PROOF 9 (idle heartbeat + caught_up): a quiet /recv must return a 200 idle
    payload {"idle": true, "cursor": N, "peers": M, "caught_up": <bool>} -- never a
    204, never a dropped socket. We also prove caught_up tracks read state: peer A
    posts; while peer B has NOT yet read it, A's idle shows caught_up:false (B is
    behind A's latest); after B recv's that post, A's idle shows caught_up:true
    (everyone has seen A's latest). We run the relay with a low RELAY_IDLE_WAIT so
    the idle returns fast instead of sitting the full ~25s default."""
    out_path = str(Path(TDIR) / "proof_idle.txt")

    # Low idle wait so each "nothing new" scan returns its heartbeat in ~1s.
    proc, base = start_relay("idle", {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120", "RELAY_IDLE_WAIT": "1"})
    assert base is not None
    passed = False
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)
            banner(fh, "PROOF 9 - IDLE HEARTBEAT (quiet recv -> 200 {idle:true,...}; caught_up tracks reads)")

            # Two peers. A will post; B is the "other" peer whose read state drives
            # A's caught_up. The log already carries the system "peer-N joined"
            # presence notices, so A drains that backlog first -- only then is A's
            # next scan genuinely "nothing new" and returns the idle heartbeat. We
            # deliberately do NOT drain B: B must stay behind A's later post so the
            # caught_up:false step below is real (recv is B's only cursor mover).
            tok_a = join_token(base)
            tok_b = join_token(base)
            get(_k(f"{base}/recv?t={tok_a}&wait=2"), timeout=HTTP_TIMEOUT)  # drain join notices

            # A's very first quiet scan: no posts at all yet -> idle, and caught_up
            # is true (A has never posted, so nobody can be behind it).
            st0, b0 = get(_k(f"{base}/recv?t={tok_a}&wait=1"), timeout=HTTP_TIMEOUT)
            idle_shape = st0 == 200 and '"idle": true' in b0 and '"cursor":' in b0 and '"peers":' in b0
            never_posted_caught = idle_shape and '"caught_up": true' in b0
            line = f"  A idle before any post -> HTTP {st0}: {b0.strip()[:140]}\n"
            print(line, end="")
            fh.write(line)

            # A posts. B has NOT read it yet (B's cursor is behind A's new entry).
            st_send, _ = post(base, tok_a, "ping from A")
            line = f"  A posts 'ping from A' -> HTTP {st_send}\n"
            print(line, end="")
            fh.write(line)

            # A drains its OWN post so A's next scan is genuinely "nothing new" and
            # returns the idle heartbeat. This advances A's cursor only -- B is
            # still at 0, behind A's post, which is what caught_up keys on.
            get(_k(f"{base}/recv?t={tok_a}&wait=2"), timeout=HTTP_TIMEOUT)

            # A's idle now: B is behind A's latest post -> caught_up must be FALSE.
            st1, b1 = get(_k(f"{base}/recv?t={tok_a}&wait=1"), timeout=HTTP_TIMEOUT)
            caught_false = st1 == 200 and '"idle": true' in b1 and '"caught_up": false' in b1
            line = f"  A idle while B unread -> HTTP {st1}: {b1.strip()[:140]} [caught_up false: {caught_false}]\n"
            print(line, end="")
            fh.write(line)

            # B now recv's -- this advances B's cursor PAST A's post.
            st_b, bb = get(_k(f"{base}/recv?t={tok_b}&wait=2"), timeout=HTTP_TIMEOUT)
            b_saw = st_b == 200 and "ping from A" in bb
            line = f"  B recv (reads A's post) -> HTTP {st_b}: {bb.strip()[:120]} [saw A: {b_saw}]\n"
            print(line, end="")
            fh.write(line)

            # A's idle again: B has now seen A's latest -> caught_up must be TRUE.
            st2, b2 = get(_k(f"{base}/recv?t={tok_a}&wait=1"), timeout=HTTP_TIMEOUT)
            caught_true = st2 == 200 and '"idle": true' in b2 and '"caught_up": true' in b2
            line = f"  A idle after B read -> HTTP {st2}: {b2.strip()[:140]} [caught_up true: {caught_true}]\n"
            print(line, end="")
            fh.write(line)

            passed = idle_shape and never_posted_caught and caught_false and b_saw and caught_true
            verdict = (
                "\nVERDICT: quiet recv returns 200 idle payload; caught_up is false while a peer "
                "is behind and true once it catches up. PASS -- idle heartbeat + caught_up correct.\n"
                if passed
                else "\nVERDICT: idle heartbeat / caught_up behaved unexpectedly (see above). FAIL.\n"
            )
            print(verdict)
            fh.write(verdict)

            get(_k(f"{base}/unplug?t={tok_a}"), timeout=2)
            get(_k(f"{base}/unplug?t={tok_b}"), timeout=2)
        finally:
            stop_relay(proc)
    print(f"[saved] {out_path}")
    return passed


def proof_cross() -> bool:
    """PROOF 10 (send-echo / cross detection): peer A posts; peer B -- whose read
    cursor is still BEHIND A's post -- then posts. B's /send response must carry
    crossed:true with A's message in `missed` (others' posts B hasn't recv'd yet).
    CRUCIALLY, the echo must NOT advance B's read cursor: we then prove B's NEXT
    recv still delivers A's message. Echo informs; recv delivers -- recv stays the
    sole cursor mover. Bounded throughout; no hang."""
    out_path = str(Path(TDIR) / "proof_cross.txt")

    proc, base = start_relay("cross", {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120", "RELAY_IDLE_WAIT": "2"})
    assert base is not None
    passed = False
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)
            banner(fh, "PROOF 10 - SEND-ECHO (cross detection; echo does NOT move the cursor)")

            tok_a = join_token(base)
            tok_b = join_token(base)

            # A posts first. B has NOT recv'd anything yet -> B's cursor is at 0,
            # behind A's entry. So when B posts, A's message crossed the wire.
            st_a, _ = post(base, tok_a, "A says hi")
            line = f"  A posts 'A says hi' -> HTTP {st_a}\n"
            print(line, end="")
            fh.write(line)

            # B posts WITHOUT having recv'd. Its send response must flag the cross
            # and list A's message in `missed`, same shape as recv entries.
            st_b, body_b = post(base, tok_b, "B says hi")
            crossed_ok = (
                st_b == 200
                and '"crossed": true' in body_b
                and '"missed":' in body_b
                and "A says hi" in body_b
                and '"ok": true' in body_b  # existing fields preserved
                and '"seq":' in body_b
                and '"handle":' in body_b
            )
            # B's own message must NOT appear in its own missed list.
            own_excluded = "B says hi" not in body_b.split('"missed"')[1]
            line = f"  B posts 'B says hi' -> HTTP {st_b}: {body_b.strip()[:200]}\n"
            print(line, end="")
            fh.write(line)
            line = f"  crossed:true with A in missed: {crossed_ok}; B's own post excluded from missed: {own_excluded}\n"
            print(line, end="")
            fh.write(line)

            # THE cursor-invariant: the echo must NOT have advanced B's read cursor.
            # B's next recv must STILL deliver A's message (and B's own post too).
            st_r, body_r = get(_k(f"{base}/recv?t={tok_b}&wait=2"), timeout=HTTP_TIMEOUT)
            redelivered = st_r == 200 and "A says hi" in body_r
            line = f"  B recv after its send -> HTTP {st_r}: {body_r.strip()[:200]} [A redelivered: {redelivered}]\n"
            print(line, end="")
            fh.write(line)

            passed = crossed_ok and own_excluded and redelivered
            verdict = (
                "\nVERDICT: B's send reported crossed:true with A's missed message, and B's cursor was "
                "NOT advanced -- recv still delivered A's post. PASS -- send-echo informs, recv delivers.\n"
                if passed
                else "\nVERDICT: send-echo / cursor invariant behaved unexpectedly (see above). FAIL.\n"
            )
            print(verdict)
            fh.write(verdict)

            get(_k(f"{base}/unplug?t={tok_a}"), timeout=2)
            get(_k(f"{base}/unplug?t={tok_b}"), timeout=2)
        finally:
            stop_relay(proc)
    print(f"[saved] {out_path}")
    return passed


def proof_brief() -> bool:
    """PROOF 4 (topic brief): start a relay launched WITH a --brief, then a peer
    jacks in and its FIRST scan must return that brief as the seq-1 system entry,
    at the TOP of the backlog. This is the topic-brief contract: the operator
    states what a discussion is about and that becomes the first thing every peer
    sees. We pass --brief on the relay's argv (alongside the host/port the
    harness already sets via env) to prove the argv path -- the same path
    /uplink uses -- not just the env fallback. The brief is multiline to prove
    embedded newlines survive argv -> log -> /recv JSON intact. Bounded wait
    (wait=2) so even a regression (no seed) surfaces as a quick 204, never a
    hang."""
    out_path = str(Path(TDIR) / "proof_brief.txt")

    brief = "SOME TEST TOPIC\nsecond line of the brief"
    passed = False
    # Generous caps so the seeded brief can't trip any close before the peer reads it.
    # start_relay sets RELAY_HOST/RELAY_PORT via env; we ALSO pass --brief on argv
    # to exercise the real launch path (argv flag, newlines preserved as one token).
    proc, base = start_relay(
        "brief",
        {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120"},
        extra_args=["--brief", brief],
    )
    assert base is not None
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)
            banner(fh, "PROOF 4 - TOPIC BRIEF (--brief seeds the seq-1 system entry; first scan returns it)")

            line = f"relay launched with --brief (multiline). Brief passed:\n  {brief!r}\n"
            print(line)
            fh.write(line)

            # A fresh peer jacks in; its FIRST scan must hand back the brief as seq-1.
            tok = join_token(base)
            line = "peer jacked in; running its FIRST scan (wait=2, bounded)\n"
            print(line)
            fh.write(line)
            status, body = get(_k(f"{base}/recv?t={tok}&wait=2"), timeout=HTTP_TIMEOUT)
            line = f"  first scan -> HTTP {status}: {body.strip()[:200]}\n"
            print(line, end="")
            fh.write(line)

            # Assert on the raw JSON text (same substring style as proof_backlog, no
            # json import needed): the first entry must be seq 1, authored "system",
            # carrying BOTH brief lines verbatim. The "\n" appears ESCAPED in the JSON
            # text, proving the embedded newline survived argv -> log -> JSON.
            seq1_is_brief = (
                status == 200
                and '"seq": 1' in body
                and '"handle": "system"' in body
                and "SOME TEST TOPIC" in body
                and "second line of the brief" in body
                and "SOME TEST TOPIC\\nsecond line of the brief" in body  # newline intact (escaped in JSON)
            )

            passed = seq1_is_brief
            verdict = (
                "\nVERDICT: first scan's seq-1 entry is the multiline system brief. "
                "PASS -- topic brief seeded + delivered on first recv.\n"
                if passed
                else f"\nVERDICT: first scan did NOT carry the brief as seq-1 (status {status}). "
                "FAIL -- topic brief not seeded.\n"
            )
            print(verdict)
            fh.write(verdict)

            # Also prove /jack's manual carries the TOPIC block (remote peer reads it
            # before its first recv). A separate jack mints another peer; fine here.
            st_m, manual = get(_k(f"{base}/jack"), timeout=HTTP_TIMEOUT)
            manual_has_topic = "TOPIC" in manual and "SOME TEST TOPIC" in manual
            line = f"  /jack manual TOPIC block present: {'YES' if manual_has_topic else 'NO'} (status {st_m})\n"
            print(line, end="")
            fh.write(line)
            passed = passed and manual_has_topic

            # Leave cleanly so the relay closes and self-exits (no stray process).
            get(_k(f"{base}/unplug?t={tok}"), timeout=2)
        finally:
            stop_relay(proc)
    print(f"[saved] {out_path}")
    return passed


def proof_gate() -> bool:
    """PROOF 5 (soft gate): the shared-secret gate must REJECT a gated route with
    NO key and with a WRONG key (HTTP 401) and ALLOW it with the RIGHT key (200),
    while /health stays OPEN (no key). We probe /trace and /jack -- the two
    key-only routes -- plus /recv (which also needs a token, but the key is
    checked FIRST, so a keyless /recv 401s before the token is even looked at).
    This is the regression guard for the old 'anyone reads /trace / mints a token'
    hole. Bounded gets throughout -- nothing here can hang."""
    out_path = str(Path(TDIR) / "proof_gate.txt")

    # Generous caps; we never trip them -- this proof just probes the gate.
    proc, base = start_relay("gate", {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120"})
    assert base is not None
    passed = False
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)
            banner(fh, "PROOF 5 - SOFT GATE (?k=<secret>): gated routes 401 without/with wrong key, 200 with right")

            line = f"relay running with secret {VERIFY_SECRET!r}; probing the gate.\n"
            print(line)
            fh.write(line)

            checks: list[tuple[str, int, int, bool]] = []  # (label, expected_status, actual_status, extra_ok)

            # /trace -- key-only gate. No key -> 401, wrong key -> 401, right key -> 200+log.
            st_none, body_none = get(f"{base}/trace", timeout=HTTP_TIMEOUT)
            checks.append(("/trace  no key   ", 401, st_none, "bad or missing key" in body_none))
            st_wrong, _ = get(f"{base}/trace?k=wrongkey", timeout=HTTP_TIMEOUT)
            checks.append(("/trace  wrong key", 401, st_wrong, True))
            st_right, body_right = get(_k(f"{base}/trace"), timeout=HTTP_TIMEOUT)
            checks.append(("/trace  right key", 200, st_right, "wire conversation" in body_right))

            # /jack -- key-only gate; returns TEXT, so its 401 is a short text body.
            st_jn, body_jn = get(f"{base}/jack", timeout=HTTP_TIMEOUT)
            checks.append(("/jack   no key   ", 401, st_jn, "bad or missing key" in body_jn))
            st_jw, _ = get(f"{base}/jack?k=wrongkey", timeout=HTTP_TIMEOUT)
            checks.append(("/jack   wrong key", 401, st_jw, True))
            st_jr, body_jr = get(_k(f"{base}/jack"), timeout=HTTP_TIMEOUT)
            checks.append(("/jack   right key", 200, st_jr, "YOUR THREE COMMANDS" in body_jr))

            # /recv -- key is checked BEFORE the token, so a keyless /recv 401s (it
            # never reaches the missing-token 400). Proves the gate is independent.
            st_rn, body_rn = get(f"{base}/recv?t=deadbeef", timeout=HTTP_TIMEOUT)
            checks.append(("/recv   no key   ", 401, st_rn, "bad or missing key" in body_rn))

            # /health -- the ONE open route. No key, must still answer 200 'ok'.
            st_h, body_h = get(f"{base}/health", timeout=HTTP_TIMEOUT)
            checks.append(("/health no key   ", 200, st_h, body_h.strip() == "ok"))

            all_ok = True
            for label, exp, act, extra in checks:
                ok = (act == exp) and extra
                all_ok = all_ok and ok
                ln = f"  {label} -> HTTP {act} (want {exp}) {'OK' if ok else 'FAIL'}\n"
                print(ln, end="")
                fh.write(ln)

            passed = all_ok
            verdict = (
                "\nVERDICT: gate rejects no-key/wrong-key with 401, allows right key with 200, "
                "/health stays open. PASS -- soft gate enforced.\n"
                if passed
                else "\nVERDICT: gate behaved unexpectedly (see FAILs above). "
                "FAIL -- soft gate not enforced as specified.\n"
            )
            print(verdict)
            fh.write(verdict)
        finally:
            # We minted one peer via the right-key /jack above; stop_relay terminates
            # the process directly (no clean unplug needed for a proof relay).
            stop_relay(proc)
    print(f"[saved] {out_path}")
    return passed


def proof_rooms_isolation() -> bool:
    """PROOF 6 (per-session rooms isolate): two relays sharing ONE RELAY_STATEDIR
    but with DIFFERENT --room ids must both bind (on different ports), write
    SEPARATE state files (.relay.<a>.* vs .relay.<b>.*), and both answer /health.
    This is the core multi-session promise: two Claude sessions on one host each
    run their own relay without clobbering each other. We use a per-test tmp
    statedir + real --room (not the per-file overrides) so the actual infix code
    path runs. Bounded throughout; both relays torn down + the dir removed."""
    out_path = str(Path(TDIR) / "proof_rooms_isolation.txt")
    sd = tempfile.mkdtemp(prefix="wire-rooms-")
    passed = False
    proc_a: subprocess.Popen[str] | None = None
    proc_b: subprocess.Popen[str] | None = None
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            banner(fh, "PROOF 6 - PER-SESSION ROOMS ISOLATE (two rooms, one statedir, different ports + files)")
            line = f"statedir={sd}\n"
            print(line, end="")
            fh.write(line)

            proc_a, base_a = start_relay(
                "room-a", {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120"}, room="aaa", statedir=sd
            )
            proc_b, base_b = start_relay(
                "room-b", {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120"}, room="bbb", statedir=sd
            )
            assert base_a is not None
            assert base_b is not None
            up_a = wait_health(base_a)
            up_b = wait_health(base_b)
            line = f"  room aaa -> {base_a} (health {'ok' if up_a else 'DOWN'})\n"
            line += f"  room bbb -> {base_b} (health {'ok' if up_b else 'DOWN'})\n"
            print(line, end="")
            fh.write(line)

            # Distinct ports (the whole point -- they coexist, no clobber).
            distinct_ports = up_a and up_b and base_a != base_b

            # Each room wrote its OWN infixed trio; the bare .relay.* must NOT exist.
            def trio(room: str) -> list[Path]:
                return [Path(sd) / f".relay.{room}.{ext}" for ext in ("pid", "port", "secret")]

            files_a = {p.name: p.exists() for p in trio("aaa")}
            files_b = {p.name: p.exists() for p in trio("bbb")}
            bare = [Path(sd) / f".relay.{ext}" for ext in ("pid", "port", "secret")]
            no_bare = not any(p.exists() for p in bare)
            line = f"  aaa files: {files_a}\n  bbb files: {files_b}\n  no bare .relay.* leaked: {no_bare}\n"
            print(line, end="")
            fh.write(line)
            files_isolated = all(files_a.values()) and all(files_b.values()) and no_bare

            passed = distinct_ports and files_isolated
            verdict = (
                "\nVERDICT: two rooms bound on different ports with isolated .relay.<id>.* files, both healthy. "
                "PASS -- per-session rooms isolate.\n"
                if passed
                else "\nVERDICT: rooms did not isolate (see above). FAIL.\n"
            )
            print(verdict)
            fh.write(verdict)
        finally:
            for p in (proc_a, proc_b):
                if p is not None:
                    stop_relay(p)
            shutil.rmtree(sd, ignore_errors=True)
    print(f"[saved] {out_path}")
    return passed


def proof_room_lock() -> bool:
    """PROOF 7 (startup lock): two relays for the SAME room + SAME statedir. The
    first claims the pidfile (O_EXCL) and binds; the SECOND must find the lock
    held by a live pid and EXIT NONZERO ("already up") WITHOUT binding -- never
    racing onto a second port. The first is unaffected (still healthy on its
    port). This closes the double-start race. Bounded; both torn down."""
    out_path = str(Path(TDIR) / "proof_room_lock.txt")
    sd = tempfile.mkdtemp(prefix="wire-lock-")
    passed = False
    proc1: subprocess.Popen[str] | None = None
    proc2: subprocess.Popen[str] | None = None
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            banner(fh, "PROOF 7 - STARTUP LOCK (same room+statedir: 2nd relay refuses, 1st unaffected)")
            proc1, base1 = start_relay(
                "lock-1", {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120"}, room="dup", statedir=sd
            )
            assert base1 is not None
            up1 = wait_health(base1)
            line = f"  first relay (room dup) -> {base1} (health {'ok' if up1 else 'DOWN'})\n"
            print(line, end="")
            fh.write(line)

            # Second relay, SAME room+statedir. It must refuse and self-exit nonzero
            # WITHOUT writing a portfile (wait_port=False -- we don't expect one).
            proc2, _ = start_relay(
                "lock-2",
                {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120"},
                room="dup",
                statedir=sd,
                wait_port=False,
            )
            try:
                rc: int | None = proc2.wait(timeout=10)
            except subprocess.TimeoutExpired:
                rc = None  # still running -> it did NOT refuse (a failure)
            second_out = ""
            with contextlib.suppress(Exception):
                second_out = (proc2.stdout.read() or "") if proc2.stdout else ""
            line = f"  second relay exit code: {rc}\n  second relay said: {second_out.strip()[:160]}\n"
            print(line, end="")
            fh.write(line)

            # First relay must STILL be healthy on its original port (untouched).
            up1_after = wait_health(base1, tries=10)
            line = f"  first relay still healthy after the refusal: {'YES' if up1_after else 'NO'}\n"
            print(line, end="")
            fh.write(line)

            second_refused = rc is not None and rc != 0 and "already up" in second_out
            passed = up1 and second_refused and up1_after
            verdict = (
                "\nVERDICT: second same-room relay exited nonzero ('already up') without binding; first unaffected. "
                "PASS -- startup lock holds.\n"
                if passed
                else "\nVERDICT: lock did not behave as specified (see above). FAIL.\n"
            )
            print(verdict)
            fh.write(verdict)
        finally:
            for p in (proc1, proc2):
                if p is not None:
                    stop_relay(p)
            shutil.rmtree(sd, ignore_errors=True)
    print(f"[saved] {out_path}")
    return passed


def proof_room_stale_reclaim() -> bool:
    """PROOF 8 (stale reclaim): pre-write a `.relay.<room>.pid` holding a DEAD pid
    (a crashed relay's leftover lock). A fresh relay for that room must notice the
    pid is dead, reclaim the lock, and start normally (bind + /health ok + the
    pidfile now holds ITS pid). Proves the lock doesn't wedge a room after a hard
    crash. Bounded; torn down + dir removed."""
    out_path = str(Path(TDIR) / "proof_room_stale_reclaim.txt")
    sd = tempfile.mkdtemp(prefix="wire-stale-")
    passed = False
    proc: subprocess.Popen[str] | None = None
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            banner(fh, "PROOF 8 - STALE LOCK RECLAIM (dead pid in pidfile -> relay reclaims + starts)")

            # Manufacture a definitely-dead pid: spawn a trivial child and reap it.
            dead = subprocess.Popen([sys.executable, "-c", "pass"])
            dead.wait()
            dead_pid = dead.pid
            # Guard against PID reuse in the (tiny) window: if it's somehow alive, skip.
            try:
                os.kill(dead_pid, 0)
                alive = True
            except OSError:
                alive = False
            pidfile = Path(sd) / ".relay.ghost.pid"
            pidfile.write_text(str(dead_pid))
            line = f"  pre-wrote stale pidfile {pidfile.name} holding dead pid {dead_pid} (alive={alive})\n"
            print(line, end="")
            fh.write(line)

            proc, base = start_relay(
                "stale", {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120"}, room="ghost", statedir=sd
            )
            assert base is not None
            up = wait_health(base)
            now_pid = pidfile.read_text().strip()
            line = f"  relay (room ghost) -> {base} (health {'ok' if up else 'DOWN'})\n"
            line += f"  pidfile now holds: {now_pid} (relay pid {proc.pid})\n"
            print(line, end="")
            fh.write(line)

            reclaimed = up and now_pid == str(proc.pid) and now_pid != str(dead_pid)
            passed = reclaimed and not alive
            verdict = (
                "\nVERDICT: relay reclaimed the stale lock and started (pidfile now holds its own pid). "
                "PASS -- stale lock reclaimed.\n"
                if passed
                else "\nVERDICT: stale lock was not reclaimed cleanly (see above). FAIL.\n"
            )
            print(verdict)
            fh.write(verdict)
        finally:
            if proc is not None:
                stop_relay(proc)
            shutil.rmtree(sd, ignore_errors=True)
    print(f"[saved] {out_path}")
    return passed


def post_last(base: str, token: str, body: str, last: int, timeout: float = HTTP_TIMEOUT) -> tuple[int, str]:
    """POST to /send WITH ?last=<seq> -- the opt-in cursor-checked send. Same as
    post() but adds &last= so we can exercise the relay's "behind" guard. The key
    rides via _k() first, then we append &last= (a real agent appends it the same
    way -- see the manual's guarded send curl)."""
    url = _k(f"{base}/send?t={token}") + f"&last={last}"
    req = urllib.request.Request(url, data=body.encode("utf-8"), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, str(e)


def proof_send_cursor_check() -> bool:
    """PROOF 11 (opt-in cursor-checked send via ?last=): peers A,B jack in. A
    posts. B then tries to send WITH a STALE ?last= (0) -- since A posted past
    seq 0, the relay must REFUSE with 409 {"ok":false,"error":"behind", latest,
    missed:[...non-empty]} and NOT append. B then sends with ?last=<current max
    seq> -> 200 ok (it has "caught up", nothing newer from others). B then sends
    with NO ?last= at all -> 200 (the legacy, unguarded path is untouched). NOTE:
    system join notices are other-authored, so they legitimately show up in
    `missed` -- expected, not a bug. Bounded throughout; no hang."""
    out_path = str(Path(TDIR) / "proof_send_cursor_check.txt")

    # Generous caps so none trips before we finish probing the guard.
    proc, base = start_relay(
        "cursorcheck", {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120", "RELAY_IDLE_WAIT": "2"}
    )
    assert base is not None
    passed = False
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)
            banner(fh, "PROOF 11 - CURSOR-CHECKED SEND (?last=): stale last -> 409 behind; fresh/none -> 200")

            tok_a = join_token(base)
            tok_b = join_token(base)

            # A posts. Capture the seq the relay assigned A's message (the current
            # max log seq) from A's own send echo -- B's fresh ?last= will use it.
            st_a, body_a = post(base, tok_a, "A's first message")
            m = re.search(r'"seq":\s*(\d+)', body_a)
            a_seq = int(m.group(1)) if m else -1
            line = f"  A posts -> HTTP {st_a}, assigned seq {a_seq}\n"
            print(line, end="")
            fh.write(line)

            # 1) B sends with a STALE last=0. A (someone else) posted past seq 0, so
            #    the guard must REFUSE: 409, error "behind", non-empty missed.
            st_stale, body_stale = post_last(base, tok_b, "B talks over A (stale)", last=0)
            stale_ok = (
                st_stale == 409
                and '"ok": false' in body_stale
                and '"error": "behind"' in body_stale
                and '"latest":' in body_stale
                and '"missed":' in body_stale
                and '"missed": []' not in body_stale  # non-empty missed
                and "A's first message" in body_stale  # A's post is what we're behind on
            )
            line = f"  B send last=0 (STALE) -> HTTP {st_stale}: {body_stale.strip()[:180]} [refused: {stale_ok}]\n"
            print(line, end="")
            fh.write(line)

            # 2) B sends with last=<current max seq>. Nothing from others is newer
            #    than a_seq, so the guard passes and the post is accepted (200 ok).
            st_fresh, body_fresh = post_last(base, tok_b, "B caught up, posting", last=a_seq)
            fresh_ok = st_fresh == 200 and '"ok": true' in body_fresh
            line = (
                f"  B send last={a_seq} (FRESH) -> HTTP {st_fresh}: {body_fresh.strip()[:160]} [accepted: {fresh_ok}]\n"
            )
            print(line, end="")
            fh.write(line)

            # 3) B sends with NO ?last= at all -> backward-compatible unguarded path.
            st_none, body_none = post(base, tok_b, "B posts with no guard")
            none_ok = st_none == 200 and '"ok": true' in body_none
            line = f"  B send (NO last=, legacy) -> HTTP {st_none}: {body_none.strip()[:160]} [accepted: {none_ok}]\n"
            print(line, end="")
            fh.write(line)

            passed = stale_ok and fresh_ok and none_ok
            verdict = (
                "\nVERDICT: stale ?last= refused with 409 'behind' (+ non-empty missed) and NOT appended; a "
                "fresh ?last= and an omitted ?last= both 200. PASS -- cursor-checked send guards correctly.\n"
                if passed
                else "\nVERDICT: cursor-checked send behaved unexpectedly (see above). FAIL.\n"
            )
            print(verdict)
            fh.write(verdict)

            get(_k(f"{base}/unplug?t={tok_a}"), timeout=2)
            get(_k(f"{base}/unplug?t={tok_b}"), timeout=2)
        finally:
            stop_relay(proc)
    print(f"[saved] {out_path}")
    return passed


def proof_presence() -> bool:
    """PROOF 12 (presence: join/leave notices + /peers): jacking a peer appends a
    system "<handle> joined" notice (mirroring the existing "<handle> left" on
    leave). We jack A -> assert "peer-1 joined" shows in /trace; jack B -> assert
    "peer-2 joined"; GET /peers -> assert count==2 with both handles listed; then
    A unplugs -> assert "peer-1 left" shows and /peers count drops to 1 (B remains,
    so the conversation stays open). Bounded gets throughout; no hang."""
    out_path = str(Path(TDIR) / "proof_presence.txt")

    proc, base = start_relay("presence", {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120"})
    assert base is not None
    passed = False
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)
            banner(fh, "PROOF 12 - PRESENCE (join/leave system notices + /peers count)")

            # Jack A. The join must land as a system "peer-1 joined" notice -- read
            # the log via /trace (a watcher view, doesn't mint a peer or move cursors).
            tok_a = join_token(base)
            _, tr1 = get(_k(f"{base}/trace"), timeout=HTTP_TIMEOUT)
            a_joined = "peer-1 joined" in tr1
            line = f"  jacked A (peer-1); '/trace' shows 'peer-1 joined': {a_joined}\n"
            print(line, end="")
            fh.write(line)

            # Jack B -> "peer-2 joined".
            tok_b = join_token(base)
            _, tr2 = get(_k(f"{base}/trace"), timeout=HTTP_TIMEOUT)
            b_joined = "peer-2 joined" in tr2
            line = f"  jacked B (peer-2); '/trace' shows 'peer-2 joined': {b_joined}\n"
            print(line, end="")
            fh.write(line)

            # /peers must now report count==2 with BOTH handles present.
            st_p, body_p = get(_k(f"{base}/peers"), timeout=HTTP_TIMEOUT)
            two_here = st_p == 200 and '"count": 2' in body_p and '"peer-1"' in body_p and '"peer-2"' in body_p
            line = f"  /peers -> HTTP {st_p}: {body_p.strip()[:160]} [count==2 + both: {two_here}]\n"
            print(line, end="")
            fh.write(line)

            # A unplugs. B remains, so the conversation stays open. The leave must
            # land as "peer-1 left" and /peers must drop to count==1 (just peer-2).
            get(_k(f"{base}/unplug?t={tok_a}"), timeout=2)
            _, tr3 = get(_k(f"{base}/trace"), timeout=HTTP_TIMEOUT)
            a_left = "peer-1 left" in tr3
            st_p2, body_p2 = get(_k(f"{base}/peers"), timeout=HTTP_TIMEOUT)
            one_here = st_p2 == 200 and '"count": 1' in body_p2 and '"peer-2"' in body_p2 and '"peer-1"' not in body_p2
            line = (
                f"  A unplugged; '/trace' shows 'peer-1 left': {a_left}; "
                f"/peers -> {body_p2.strip()[:120]} [count==1 (only peer-2): {one_here}]\n"
            )
            print(line, end="")
            fh.write(line)

            passed = a_joined and b_joined and two_here and a_left and one_here
            verdict = (
                "\nVERDICT: join appends '<handle> joined'; both peers list at count 2; a leave appends "
                "'<handle> left' and drops the count to 1. PASS -- presence notices + /peers correct.\n"
                if passed
                else "\nVERDICT: presence notices / peer count behaved unexpectedly (see above). FAIL.\n"
            )
            print(verdict)
            fh.write(verdict)

            get(_k(f"{base}/unplug?t={tok_b}"), timeout=2)
        finally:
            stop_relay(proc)
    print(f"[saved] {out_path}")
    return passed


def proof_last_peer_closes() -> bool:
    """PROOF 13 (last peer leaves -> close cascade): a SINGLE agent jacks in; we
    park a long-poll /recv on a thread, then that one peer unplugs -- the LAST peer
    out. Three things must follow: (1) the parked /recv is RELEASED carrying the
    closed signal ({"system":"conversation closed..."}), not left to sit out its
    600s; (2) the relay PROCESS self-exits within a few seconds (lifecycle ==
    process); (3) the room's state files (.relay.<room>.{pid,port,secret}) are all
    removed by the close path. This is the path that couldn't be checked live in an
    earlier proof -- here it's made solid with bounded polling. We use room mode so
    the exact state-file paths are known. Bounded throughout; no hang."""
    out_path = str(Path(TDIR) / "proof_last_peer_closes.txt")
    sd = tempfile.mkdtemp(prefix="wire-lastpeer-")
    room = "solo"
    passed = False
    proc: subprocess.Popen[str] | None = None
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            banner(fh, "PROOF 13 - LAST PEER LEAVES (parked recv released + process exits + files removed)")
            proc, base = start_relay(
                "lastpeer", {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120"}, room=room, statedir=sd
            )
            assert base is not None
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)

            trio = [Path(sd) / f".relay.{room}.{ext}" for ext in ("pid", "port", "secret")]
            files_before = {p.name: p.exists() for p in trio}
            line = f"  state files present before close: {files_before}\n"
            print(line, end="")
            fh.write(line)

            # ONE peer. Drain its OWN join-notice backlog first (a fresh peer's
            # cursor starts at 0, so the seq-1 "peer-1 joined" system entry would
            # otherwise satisfy the parked recv immediately and it would never see
            # the close). After draining, the parked long-poll has nothing pending,
            # so when the peer unplugs it is the CLOSE that releases it -- carrying
            # the closed signal, which is exactly what we assert. (Same backlog-drain
            # the idle proof does before its idle assertion.)
            tok = join_token(base)
            get(_k(f"{base}/recv?t={tok}&wait=2"), timeout=HTTP_TIMEOUT)  # drain join notice
            results: dict[int, dict[str, Any]] = {}
            parker = threading.Thread(target=park_recv, args=(base, tok, results, 0))
            parker.start()
            time.sleep(0.5)  # ensure the recv is genuinely parked on cond.wait

            get(_k(f"{base}/unplug?t={tok}"), timeout=2)  # last peer leaves -> close
            line = "  the sole peer unplugged (last peer out -> conversation must close)\n"
            print(line, end="")
            fh.write(line)

            # (1) the parked recv must release quickly carrying the closed signal.
            parker.join(timeout=HTTP_TIMEOUT + 3)
            r = results.get(0, {"elapsed": -1, "status": "NO-RESULT(STILL BLOCKED)", "body": ""})
            recv_released = (
                isinstance(r["elapsed"], (int, float))
                and 0 <= r["elapsed"] < 5.0
                and r["status"] == 200
                and "conversation closed" in r["body"]
            )
            line = f"  parked recv released after {r['elapsed']}s (status {r['status']}) <- {r['body']}\n"
            print(line, end="")
            fh.write(line)

            # (2) the process must self-exit within a few seconds (0.4s grace + slack).
            exited = False
            deadline = time.time() + 5
            while time.time() < deadline:
                if proc.poll() is not None:
                    exited = True
                    break
                time.sleep(0.1)
            line = f"  relay process self-exited on last-peer close: {'YES' if exited else 'NO'} (exit={proc.poll()})\n"
            print(line, end="")
            fh.write(line)

            # (3) all three state files must be gone (the close path removes them).
            #     Poll briefly: removal happens in the shutdown thread alongside exit.
            files_gone = False
            deadline = time.time() + 3
            while time.time() < deadline:
                if not any(p.exists() for p in trio):
                    files_gone = True
                    break
                time.sleep(0.1)
            files_after = {p.name: p.exists() for p in trio}
            line = f"  state files after close: {files_after} [all removed: {files_gone}]\n"
            print(line, end="")
            fh.write(line)

            passed = recv_released and exited and files_gone
            verdict = (
                "\nVERDICT: last peer's leave released the parked recv with the closed signal, the process "
                "self-exited, and all state files were removed. PASS -- last-peer close cascade solid.\n"
                if passed
                else "\nVERDICT: last-peer close cascade behaved unexpectedly (see above). FAIL.\n"
            )
            print(verdict)
            fh.write(verdict)
        finally:
            if proc is not None:
                stop_relay(proc)
            shutil.rmtree(sd, ignore_errors=True)
    print(f"[saved] {out_path}")
    return passed


def proof_sigterm_cleanup() -> bool:
    """PROOF 14 (SIGTERM cleanup): start a relay (room mode -> known state-file
    paths), capture its pid and the .relay.<room>.{pid,port,secret} paths, then
    send SIGTERM. The signal handler turns the term into a clean exit so atexit
    fires: the process must be GONE and all three state files removed -- never
    stranded (a stranded pidfile would wedge the room's startup lock). This guards
    the regression where the default `kill` left the files behind. Bounded polling;
    no hang."""
    out_path = str(Path(TDIR) / "proof_sigterm_cleanup.txt")
    sd = tempfile.mkdtemp(prefix="wire-sigterm-")
    room = "term"
    passed = False
    proc: subprocess.Popen[str] | None = None
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            banner(fh, "PROOF 14 - SIGTERM CLEANUP (term -> process gone + .relay.<room>.* all removed)")
            proc, base = start_relay(
                "sigterm", {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120"}, room=room, statedir=sd
            )
            assert base is not None
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)

            trio = [Path(sd) / f".relay.{room}.{ext}" for ext in ("pid", "port", "secret")]
            files_before = {p.name: p.exists() for p in trio}
            line = f"  relay up (pid {proc.pid}); state files present: {files_before}\n"
            print(line, end="")
            fh.write(line)

            # Send SIGTERM -- the default `kill`. proc.terminate() IS SIGTERM on
            # POSIX (this harness is localhost/unix). The relay's handler runs
            # cleanup + exit(0), so atexit's file removal fires.
            proc.terminate()
            line = f"  sent SIGTERM (terminate) to pid {proc.pid}\n"
            print(line, end="")
            fh.write(line)

            # Process must terminate promptly.
            try:
                rc: int | None = proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                rc = None
            gone = rc is not None
            line = f"  process exited after SIGTERM: {'YES' if gone else 'NO'} (exit={rc})\n"
            print(line, end="")
            fh.write(line)

            # All three state files must be removed (atexit cleanup via the handler).
            files_gone = False
            deadline = time.time() + 3
            while time.time() < deadline:
                if not any(p.exists() for p in trio):
                    files_gone = True
                    break
                time.sleep(0.1)
            files_after = {p.name: p.exists() for p in trio}
            line = f"  state files after SIGTERM: {files_after} [all removed: {files_gone}]\n"
            print(line, end="")
            fh.write(line)

            passed = gone and files_gone
            verdict = (
                "\nVERDICT: SIGTERM exited the process and removed .relay.<room>.{pid,port,secret}. "
                "PASS -- signal cleanup leaves no stranded files.\n"
                if passed
                else "\nVERDICT: SIGTERM cleanup behaved unexpectedly (see above). FAIL.\n"
            )
            print(verdict)
            fh.write(verdict)
        finally:
            if proc is not None:
                stop_relay(proc)
            shutil.rmtree(sd, ignore_errors=True)
    print(f"[saved] {out_path}")
    return passed


if __name__ == "__main__":
    Path(TDIR).mkdir(parents=True, exist_ok=True)
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    _start_watchdog()  # hard ceiling: nothing here can hang past WATCHDOG_SECONDS
    t0 = time.time()
    # Proofs that return a clear pass/fail bool are tracked so the run can exit
    # nonzero if any fails (the group/safety proofs print their own verdicts).
    results: dict[str, bool] = {}
    try:
        if which in ("all", "group"):
            proof_group()
        if which in ("all", "backlog"):
            results["backlog"] = proof_backlog()
        if which in ("all", "idle"):
            results["idle"] = proof_idle()
        if which in ("all", "cross"):
            results["cross"] = proof_cross()
        if which in ("all", "cursorcheck"):
            results["send_cursor_check"] = proof_send_cursor_check()
        if which in ("all", "presence"):
            results["presence"] = proof_presence()
        if which in ("all", "lastpeer"):
            results["last_peer_closes"] = proof_last_peer_closes()
        if which in ("all", "sigterm"):
            results["sigterm_cleanup"] = proof_sigterm_cleanup()
        if which in ("all", "brief"):
            results["brief"] = proof_brief()
        if which in ("all", "gate"):
            results["gate"] = proof_gate()
        if which in ("all", "rooms"):
            results["rooms_isolation"] = proof_rooms_isolation()
        if which in ("all", "rooms", "lock"):
            results["room_lock"] = proof_room_lock()
        if which in ("all", "rooms", "stale"):
            results["room_stale_reclaim"] = proof_room_stale_reclaim()
        if which in ("all", "safety"):
            proof_safety()
        if results:
            tail = ", ".join(f"{k}={'PASS' if v else 'FAIL'}" for k, v in results.items())
            print(f"\nproof results: {tail}")
        print(f"verification complete in {time.time() - t0:.1f}s.")
    finally:
        # Belt-and-suspenders: reap anything still alive so we never leave a
        # stray relay or agent behind, even on an exception.
        _kill_all()
    if results and not all(results.values()):
        sys.exit(1)
