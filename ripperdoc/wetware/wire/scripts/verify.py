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
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
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


def join_with_role(base: str, role: str, timeout: float = HTTP_TIMEOUT) -> tuple[str, str]:
    """Jack in WITH a ?role= and scrape both the token and the role greeting out
    of the manual. Returns (token, manual_text) so a proof can assert the manual
    reflected the role. Mirrors join_token but carries &role= on the URL. The role
    is URL-encoded so control chars (e.g. a newline, for the sanitize check) reach
    the relay instead of tripping urllib's own control-char guard client-side."""
    url = _k(f"{base}/jack") + f"&role={urllib.parse.quote(role, safe='')}"
    status, manual = get(url, timeout=timeout)
    m = re.search(r"/recv\?t=([0-9a-f]+)", manual)
    if not m:
        raise RuntimeError(f"jack(role) failed ({status}): {manual[:120]}")
    return m.group(1), manual


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


def post_envelope(base: str, token: str, envelope: dict, timeout: float = HTTP_TIMEOUT) -> tuple[int, str]:
    """POST a JSON ADDRESSING ENVELOPE body {"body":..., "to":..., ...} to /send
    (key on the URL). The envelope is json.dumps'd so a real {"body":...} send is
    exercised end to end. Returns (status, text)."""
    data = json.dumps(envelope).encode("utf-8")
    req = urllib.request.Request(_k(f"{base}/send?t={token}"), data=data, method="POST")
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
                # missed entries must carry is_me, same shape as recv entries (the
                # manual claims so). A's post is someone else's -> is_me false.
                and '"is_me": false' in body_b.split('"missed"')[1]
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
    embedded newlines survive argv -> log -> /recv JSON intact. We ALSO assert the
    brief surfaces as the topic in /peers JSON and the /trace header: no
    RELAY_TOPIC is set, so both must FALL BACK to the brief's first line (the
    topic-brief-invisible-to-/peers fix). Bounded wait (wait=2) so even a
    regression (no seed) surfaces as a quick 204, never a hang."""
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

            # And prove /peers surfaces the topic too. No RELAY_TOPIC was set -- only
            # --brief -- so this exercises the brief-fallback fix: with self.topic
            # empty, /peers' "topic" field must show the brief's FIRST line (NOT the
            # second line, NOT empty). Regression guard for the old bug where /peers
            # (and the /trace header) read self.topic only and rendered blank under a
            # --brief launch.
            st_p, body_p = get(_k(f"{base}/peers"), timeout=HTTP_TIMEOUT)
            peers_topic_ok = (
                st_p == 200
                and '"topic": "SOME TEST TOPIC"' in body_p  # first brief line, exact
                and "second line of the brief" not in body_p  # only the first line
            )
            line = f"  /peers topic (brief fallback) -> HTTP {st_p}: {body_p.strip()[:160]} [first-line topic: {peers_topic_ok}]\n"
            print(line, end="")
            fh.write(line)
            passed = passed and peers_topic_ok

            # /trace header must carry the same fallback topic (reads self.topic ->
            # brief first line). Proves both readers share the fallback.
            st_t, trace = get(_k(f"{base}/trace"), timeout=HTTP_TIMEOUT)
            trace_topic_ok = st_t == 200 and "topic: SOME TEST TOPIC" in trace.splitlines()[0]
            line = f"  /trace header topic (brief fallback): {'YES' if trace_topic_ok else 'NO'} (status {st_t})\n"
            print(line, end="")
            fh.write(line)
            passed = passed and trace_topic_ok

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
                # 409 missed entries carry is_me too (same shape as recv); A's post
                # is someone else's -> is_me false. Shape-consistency guard.
                and '"is_me": false' in body_stale.split('"missed"')[1]
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


def post_raw(base: str, token: str, raw: bytes, timeout: float = HTTP_TIMEOUT) -> tuple[int, str]:
    """POST arbitrary RAW bytes to /send (key on the URL). Like post() but takes
    bytes (not a str), so a proof can send an over-cap body without utf-8 framing
    getting in the way of the byte count. Returns (status, text). A connection the
    relay closed under us surfaces as status 0 from get()'s except path -- callers
    that expect a 413 read the status, not the closed socket."""
    req = urllib.request.Request(_k(f"{base}/send?t={token}"), data=raw, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, str(e)


def peers_turns(base: str) -> int:
    """Read the accepted-post count (`turns`) off /peers. The proofs use it as the
    "did this post actually append?" witness -- a rejected post must leave it
    unchanged. Returns -1 if /peers can't be read/parsed."""
    st, body = get(_k(f"{base}/peers"), timeout=HTTP_TIMEOUT)
    m = re.search(r'"turns":\s*(\d+)', body)
    return int(m.group(1)) if (st == 200 and m) else -1


def floor(base: str, token: str, op: str, timeout: float = HTTP_TIMEOUT) -> tuple[int, dict]:
    """GET /floor?op=<op> for the floor proofs. Gated like /send: key via _k()
    first, then &t=<token>&op=<op> appended -- exactly the URL a real agent's
    manual prints. Returns (status, parsed_json_dict); a non-JSON/transport error
    yields (status, {}) so callers can assert on .get(...) without a try."""
    url = _k(f"{base}/floor?t={token}") + f"&op={op}"
    st, body = get(url, timeout=timeout)
    try:
        obj = json.loads(body)
    except (ValueError, TypeError):
        obj = {}
    return st, obj if isinstance(obj, dict) else {}


def proof_body_cap() -> bool:
    """PROOF 14 (body-size cap, RELAY_MAX_BODY): relay launched with
    RELAY_MAX_BODY=64. (1) An UNDER-cap raw post -> 200 (the cap doesn't break the
    normal path). (2) An OVER-cap RAW post -> 413 {"ok":false,"error":"body too
    large","max_bytes":64} -- the body is rejected before it can append. (3) An
    OVER-cap post via {"body":"<oversized>"} JSON ALSO -> 413, proving the size
    guard sits in _read_body BEFORE the JSON sniff (so both the raw and JSON paths
    are capped from the one choke point). After the two rejects we assert the
    accepted-post count (/peers `turns`) did NOT advance past the single under-cap
    post -- the oversized bodies never appended. Bounded throughout; no hang."""
    out_path = str(Path(TDIR) / "proof_body_cap.txt")

    # Tiny 64-byte cap so the proof's strings are small; generous lifecycle caps so
    # nothing else trips while we probe the body guard.
    proc, base = start_relay("bodycap", {"RELAY_MAX_BODY": "64", "RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120"})
    assert base is not None
    passed = False
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)
            banner(
                fh, "PROOF 14 - BODY-SIZE CAP (RELAY_MAX_BODY=64): under-cap 200; over-cap raw+JSON 413, not appended"
            )

            tok = join_token(base)

            # 1) Under-cap raw post -> 200 (normal path still works under the cap).
            st_ok, body_ok = post(base, tok, "small one")
            under_ok = st_ok == 200 and '"ok": true' in body_ok
            line = f"  under-cap post ('small one') -> HTTP {st_ok} [accepted: {under_ok}]\n"
            print(line, end="")
            fh.write(line)
            turns_after_ok = peers_turns(base)  # should be 1 (the one accepted post)

            # 2) Over-cap RAW post -> 413 with error + max_bytes. 200 bytes >> 64.
            big = b"X" * 200
            st_big, body_big = post_raw(base, tok, big)
            raw_413_ok = (
                st_big == 413
                and '"ok": false' in body_big
                and '"error": "body too large"' in body_big
                and '"max_bytes": 64' in body_big
            )
            line = f"  over-cap RAW post (200B) -> HTTP {st_big}: {body_big.strip()[:160]} [413: {raw_413_ok}]\n"
            print(line, end="")
            fh.write(line)

            # 3) Over-cap via {"body": "<oversized>"} JSON -> ALSO 413. The whole
            #    JSON envelope is well over 64 bytes, so the size guard (which runs
            #    BEFORE the JSON sniff in _read_body) must fire first. Proves the cap
            #    is in the body-read choke point, not bolted onto the raw path only.
            big_json = b'{"body": "' + b"Y" * 200 + b'"}'
            st_json, body_json = post_raw(base, tok, big_json)
            json_413_ok = st_json == 413 and '"error": "body too large"' in body_json and '"max_bytes": 64' in body_json
            line = f"  over-cap JSON post -> HTTP {st_json}: {body_json.strip()[:160]} [413: {json_413_ok}]\n"
            print(line, end="")
            fh.write(line)

            # 4) Neither oversized body appended: turns is still just the 1 under-cap
            #    post (rejection happens before _append). Re-read /peers now.
            turns_now = peers_turns(base)
            not_appended = turns_after_ok == 1 and turns_now == 1
            line = f"  accepted-post count: after under-cap={turns_after_ok}, after both rejects={turns_now} [not appended: {not_appended}]\n"
            print(line, end="")
            fh.write(line)

            passed = under_ok and raw_413_ok and json_413_ok and not_appended
            verdict = (
                '\nVERDICT: under-cap 200; over-cap raw AND {"body":...} JSON both 413 (guard in _read_body before '
                "the JSON sniff) with max_bytes=64; oversized bodies never appended. PASS -- body-size cap enforced.\n"
                if passed
                else "\nVERDICT: body-size cap behaved unexpectedly (see above). FAIL.\n"
            )
            print(verdict)
            fh.write(verdict)

            get(_k(f"{base}/unplug?t={tok}"), timeout=2)
        finally:
            stop_relay(proc)
    print(f"[saved] {out_path}")
    return passed


def proof_send_rate() -> bool:
    """PROOF 15 (per-peer send rate gate, RELAY_MIN_SEND_INTERVAL): relay launched
    with RELAY_MIN_SEND_INTERVAL=0.5 and a HIGH RELAY_REPEAT_WINDOW (so the
    repetition kill, not the rate gate, is NOT what fires -- the posts differ
    anyway). (1) 1st post -> 200. (2) An IMMEDIATE 2nd post -> 429
    {"ok":false,"error":"rate limited","retry_after":<secs>,"min_interval":0.5}
    and NOT appended. (3) Sleep ~0.6s (> the 0.5s interval, bounded, well under the
    watchdog) and post a 3rd -> 200: the window has elapsed. We also assert the
    throttled post did NOT advance the accepted-post count (/peers `turns`).
    Bounded sleep + bounded gets; no hang."""
    out_path = str(Path(TDIR) / "proof_send_rate.txt")

    # 0.5s gate; REPEAT_WINDOW high so identical-consecutive isn't what trips; the
    # three posts below differ regardless. Generous turn/wall caps.
    proc, base = start_relay(
        "sendrate",
        {
            "RELAY_MIN_SEND_INTERVAL": "0.5",
            "RELAY_REPEAT_WINDOW": "50",
            "RELAY_MAX_TURNS": "40",
            "RELAY_MAX_SECONDS": "120",
        },
    )
    assert base is not None
    passed = False
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)
            banner(
                fh, "PROOF 15 - SEND RATE GATE (RELAY_MIN_SEND_INTERVAL=0.5): too-soon 2nd -> 429; after wait -> 200"
            )

            tok = join_token(base)

            # 1) First post -> accepted (a peer's first send is never throttled).
            st1, body1 = post(base, tok, "first post")
            first_ok = st1 == 200 and '"ok": true' in body1
            line = f"  1st post -> HTTP {st1} [accepted: {first_ok}]\n"
            print(line, end="")
            fh.write(line)
            turns_after_1 = peers_turns(base)  # expect 1

            # 2) Immediate 2nd post -> 429 (inside the 0.5s window), NOT appended.
            st2, body2 = post(base, tok, "too soon")
            rate_ok = (
                st2 == 429
                and '"ok": false' in body2
                and '"error": "rate limited"' in body2
                and '"retry_after"' in body2
                and '"min_interval": 0.5' in body2
            )
            turns_after_2 = peers_turns(base)  # must STILL be 1 -- throttled post didn't land
            not_appended = turns_after_1 == 1 and turns_after_2 == 1
            line = f"  immediate 2nd post -> HTTP {st2}: {body2.strip()[:160]} [429: {rate_ok}; not appended: {not_appended}]\n"
            print(line, end="")
            fh.write(line)

            # 3) Wait out the interval (0.6s > 0.5s; bounded, far under the watchdog)
            #    then post again -> accepted. The window has elapsed.
            time.sleep(0.6)
            st3, body3 = post(base, tok, "after the wait")
            third_ok = st3 == 200 and '"ok": true' in body3
            turns_after_3 = peers_turns(base)  # expect 2 now (posts 1 and 3)
            line = f"  3rd post (after ~0.6s) -> HTTP {st3} [accepted: {third_ok}; turns now {turns_after_3}]\n"
            print(line, end="")
            fh.write(line)

            passed = first_ok and rate_ok and not_appended and third_ok and turns_after_3 == 2
            verdict = (
                "\nVERDICT: 1st post 200; an immediate 2nd 429 ('rate limited', retry_after, min_interval=0.5) and NOT "
                "appended; after a ~0.6s wait the 3rd posts 200. PASS -- per-peer send rate gate enforced.\n"
                if passed
                else "\nVERDICT: send rate gate behaved unexpectedly (see above). FAIL.\n"
            )
            print(verdict)
            fh.write(verdict)

            get(_k(f"{base}/unplug?t={tok}"), timeout=2)
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


def proof_peer_reap() -> bool:
    """PROOF 15 (presence reaper): a peer that jacks in and then goes SILENT
    (never polls, never sends) must be REAPED -- dropped from /peers within
    ~PEER_TIMEOUT with a '<handle> left (timed out)' system line -- and, when the
    LONE remaining peer times out, the conversation must CLOSE (closed system
    message) and the process EXIT, exactly like the last /unplug. We run with a
    SHORT RELAY_PEER_TIMEOUT (2s) so it's fast. Two parts:

      (a) DROP: jack A and B (raw HTTP jack, then we simply never poll for A), but
          keep B alive by re-issuing /recv just inside the timeout. Within ~timeout
          A is gone from /peers (count drops to just B) and /trace shows
          'peer-1 left (timed out)', while the room stays OPEN (B still here).
      (b) CLOSE-ON-EMPTY: then we stop polling B too. With every peer silent, the
          reaper thread -- not any request -- must empty the room, post
          'conversation closed: all peers timed out', and the process must self-exit.
          This is the core bug: if all agents die at once, nothing else would ever
          close the room.

    Room mode so the state-file paths are known and we can confirm the close path
    removed them. Bounded polling throughout; no hang."""
    out_path = str(Path(TDIR) / "proof_peer_reap.txt")
    sd = tempfile.mkdtemp(prefix="wire-reap-")
    room = "reap"
    passed = False
    proc: subprocess.Popen[str] | None = None
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            banner(fh, "PROOF 15 - PRESENCE REAPER (silent peer dropped + lone-silent-peer close-on-empty)")
            # Short peer timeout so the silent peer is reaped fast. Generous caps so
            # only the reaper -- not a turn/wall cap -- can end this run.
            proc, base = start_relay(
                "reap",
                {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120", "RELAY_PEER_TIMEOUT": "2"},
                room=room,
                statedir=sd,
            )
            assert base is not None
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)

            trio = [Path(sd) / f".relay.{room}.{ext}" for ext in ("pid", "port", "secret")]

            # --- (a) DROP a silent peer while another stays alive --------------
            # A and B both jack in (raw HTTP -- the suite's existing helper). We
            # NEVER poll for A, so A goes silent immediately. B we keep alive by
            # re-issuing /recv (each recv refreshes B's last_seen on arrival).
            tok_a = join_token(base)
            tok_b = join_token(base)
            line = "jacked A (peer-1) and B (peer-2); A will go SILENT, B keeps polling\n"
            print(line, end="")
            fh.write(line)

            # Keep B alive across the timeout window: poll B a few times with a
            # bounded wait while we wait out A's ~2s timeout (+ a sweep interval).
            a_dropped = False
            a_timed_out_line = False
            deadline = time.time() + 8
            while time.time() < deadline:
                # B's recv refreshes B's presence on every call (arrival), so B is
                # never reaped; the bounded wait also paces this loop.
                get(_k(f"{base}/recv?t={tok_b}&wait=1"), timeout=HTTP_TIMEOUT)
                st_p, body_p = get(_k(f"{base}/peers"), timeout=HTTP_TIMEOUT)
                _, tr = get(_k(f"{base}/trace"), timeout=HTTP_TIMEOUT)
                # A gone, B still present, room still open == the drop landed.
                if st_p == 200 and '"peer-1"' not in body_p and '"peer-2"' in body_p and '"closed": false' in body_p:
                    a_dropped = True
                    a_timed_out_line = "peer-1 left (timed out)" in tr
                    line = f"  A reaped: /peers={body_p.strip()[:140]} [peer-1 gone, peer-2 stays, open: {a_dropped}]\n"
                    print(line, end="")
                    fh.write(line)
                    line = f"  /trace shows 'peer-1 left (timed out)': {a_timed_out_line}\n"
                    print(line, end="")
                    fh.write(line)
                    break
            if not a_dropped:
                line = "  A was NOT reaped within the window (FAIL)\n"
                print(line, end="")
                fh.write(line)

            # --- (b) CLOSE-ON-EMPTY when the lone peer also goes silent --------
            # Now stop polling B entirely. With every peer silent, the reaper thread
            # must drop B, close the conversation, and exit the process -- no request
            # is made here, proving the thread (not a lazy sweep) guarantees closure.
            line = "now B goes silent too (no more polling) -> reaper must close the room + exit the process\n"
            print(line, end="")
            fh.write(line)

            exited = False
            deadline = time.time() + 8  # ~2s timeout + sweep interval + 0.4s grace + slack
            while time.time() < deadline:
                if proc.poll() is not None:
                    exited = True
                    break
                time.sleep(0.1)
            line = f"  relay process self-exited on all-peers-timed-out: {'YES' if exited else 'NO'} (exit={proc.poll()})\n"
            print(line, end="")
            fh.write(line)

            # The close path posts the closed notice and removes the state files.
            # Process is gone, so read the closed notice from the captured stdout
            # ([close] all peers timed out ...) and confirm the files are removed.
            close_logged = False
            with contextlib.suppress(Exception):
                if proc.stdout is not None:
                    relay_out = proc.stdout.read() or ""
                    close_logged = "all peers timed out" in relay_out
            files_gone = False
            d2 = time.time() + 3
            while time.time() < d2:
                if not any(p.exists() for p in trio):
                    files_gone = True
                    break
                time.sleep(0.1)
            line = f"  relay logged 'all peers timed out' close: {close_logged}; state files removed: {files_gone}\n"
            print(line, end="")
            fh.write(line)

            passed = a_dropped and a_timed_out_line and exited and close_logged and files_gone
            verdict = (
                "\nVERDICT: a silent peer was reaped (dropped from /peers + 'left (timed out)' line) while another "
                "stayed; then the lone silent peer's timeout closed the conversation and exited the process. "
                "PASS -- presence reaper drops dead peers and guarantees close-on-empty.\n"
                if passed
                else "\nVERDICT: presence reaper behaved unexpectedly (see above). FAIL.\n"
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


def proof_role_surfaces() -> bool:
    """PROOF 16 (peer role at /jack): a peer that jacks with ?role=<str> gets the
    role reflected in its manual greeting, listed in /peers' `roles` map, and
    stamped onto its authored entries (recv carries the author's `role`). A peer
    that jacks WITHOUT ?role= has NO `role` key anywhere -- the field is OMITTED
    WHEN ABSENT, so a roleless room is byte-identical to before. We also prove the
    relay carries the role verbatim (no enum) and strips newlines / len-caps it.
    Bounded gets throughout; no hang."""
    out_path = str(Path(TDIR) / "proof_role_surfaces.txt")

    proc, base = start_relay("role", {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120", "RELAY_IDLE_WAIT": "2"})
    assert base is not None
    passed = False
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)
            banner(fh, "PROOF 16 - PEER ROLE (?role= at /jack: manual greeting + /peers roles + entry author role)")

            # A jacks WITH a role; the manual greeting must name it.
            tok_a, manual_a = join_with_role(base, "architect")
            greet_ok = "role: architect" in manual_a
            line = f"  A jacked role=architect; manual greeting names it: {greet_ok}\n"
            print(line, end="")
            fh.write(line)

            # B jacks WITHOUT a role -- proves the absent case stays absent.
            tok_b = join_token(base)
            line = "  B jacked with NO role\n"
            print(line, end="")
            fh.write(line)

            # /peers `roles` map: A present with its role, B absent (no role key
            # for B), and `peers` + `count` unchanged (both handles, count 2).
            st_p, body_p = get(_k(f"{base}/peers"), timeout=HTTP_TIMEOUT)
            roles_ok = (
                st_p == 200
                and '"roles":' in body_p
                and '"peer-1": "architect"' in body_p
                and '"peer-2"' not in body_p.split('"roles"')[1].split("}")[0]  # B not in the roles map
                and '"count": 2' in body_p  # count unchanged
                and '"peer-1"' in body_p
                and '"peer-2"' in body_p  # both still in `peers`
            )
            line = f"  /peers -> HTTP {st_p}: {body_p.strip()[:200]} [roles map A-only, count==2: {roles_ok}]\n"
            print(line, end="")
            fh.write(line)

            # A posts; A's entry (echoed on recv) must carry the AUTHOR role.
            post(base, tok_a, "design proposal from A")
            # B recv's to read A's post and check the stamped role; B's view of A's
            # entry carries role=architect (author role), and is NOT is_me for B.
            st_r, body_r = get(_k(f"{base}/recv?t={tok_b}&wait=2"), timeout=HTTP_TIMEOUT)
            entry_role_ok = st_r == 200 and "design proposal from A" in body_r and '"role": "architect"' in body_r
            line = f"  B recv reads A's post -> HTTP {st_r}: {body_r.strip()[:200]} [entry carries author role: {entry_role_ok}]\n"
            print(line, end="")
            fh.write(line)

            # B posts; B has NO role -> B's entry must carry NO `role` key. Read it
            # back via A's recv (A drains, finds B's entry, asserts role absent).
            post(base, tok_b, "reply from roleless B")
            st_ra, body_ra = get(_k(f"{base}/recv?t={tok_a}&wait=2"), timeout=HTTP_TIMEOUT)
            # Find B's entry in A's recv batch and confirm no role key rode with it.
            # (A's own 'design proposal' entry has a role; we check B's specifically.)
            b_entry_roleless = st_ra == 200 and "reply from roleless B" in body_ra
            if b_entry_roleless:
                # Crude slice: the chunk around B's body must not contain a role key
                # before the next entry boundary. B authored it, so handle=peer-2.
                chunk = body_ra.split("reply from roleless B")[0]
                # the LAST '{' before B's body opens B's entry object
                b_obj = chunk.rsplit("{", 1)[-1]
                b_entry_roleless = '"role"' not in b_obj
            line = f"  A recv reads B's post -> HTTP {st_ra}: {body_ra.strip()[:200]} [B entry has NO role key: {b_entry_roleless}]\n"
            print(line, end="")
            fh.write(line)

            # Hygiene: a role with embedded newlines + over-length is sanitized
            # (newlines stripped, capped) -- the relay carries it, never an enum.
            tok_c, _manual_c = join_with_role(base, "x" * 60 + "\nINJECTED")
            st_pc, body_pc = get(_k(f"{base}/peers"), timeout=HTTP_TIMEOUT)
            # The stored role for peer-3 must have no newline and be capped to the
            # 24-char x-run (ROLE_MAX) -- the trailing "\nINJECTED" is stripped to a
            # space then truncated away. Re-derive it straight from the roles map.
            m = re.search(r'"peer-3":\s*"([^"]*)"', body_pc)
            stored = m.group(1) if m else ""
            sanit_ok = stored == "x" * 24 and "\n" not in stored and "INJECTED" not in stored
            line = f"  C jacked role with newline+overlong -> stored {stored!r} [sanitized to 24 x's, no newline: {sanit_ok}]\n"
            print(line, end="")
            fh.write(line)

            passed = greet_ok and roles_ok and entry_role_ok and b_entry_roleless and sanit_ok
            verdict = (
                "\nVERDICT: ?role= reflects in the manual greeting + /peers roles map + the author's entries; a "
                "roleless peer has NO role key anywhere; the role is carried verbatim (no enum) but newline-stripped "
                "and len-capped. PASS -- peer role surfaces, omitted when absent.\n"
                if passed
                else "\nVERDICT: peer role behaved unexpectedly (see above). FAIL.\n"
            )
            print(verdict)
            fh.write(verdict)

            get(_k(f"{base}/unplug?t={tok_a}"), timeout=2)
            get(_k(f"{base}/unplug?t={tok_b}"), timeout=2)
            get(_k(f"{base}/unplug?t={tok_c}"), timeout=2)
        finally:
            stop_relay(proc)
    print(f"[saved] {out_path}")
    return passed


def proof_envelope_roundtrip() -> bool:
    """PROOF 17 (send envelope round-trips): a {"body", to, reply_to, kind} send is
    accepted, the fields are echoed in the send reply, ride the recv entry, show in
    the missed[] arrays, and render in the /trace suffix. We also prove sanitizing:
    a bare-string `to` is coerced to a 1-elem list; a non-string `to` element is
    dropped; a `reply_to` < 1 is dropped; `kind` is carried FREE-FORM (no enum) but
    newline-stripped. Bounded throughout; no hang."""
    out_path = str(Path(TDIR) / "proof_envelope_roundtrip.txt")

    proc, base = start_relay("envrt", {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120", "RELAY_IDLE_WAIT": "2"})
    assert base is not None
    passed = False
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)
            banner(
                fh, "PROOF 17 - SEND ENVELOPE ROUND-TRIP (to/reply_to/kind echoed, on recv entry, in missed, /trace)"
            )

            tok_a = join_token(base)
            tok_b = join_token(base)

            # A sends a fully-populated envelope. `to` is a LIST, reply_to a valid
            # seq, kind free-form. The send reply must echo all three back.
            st_a, body_a = post_envelope(
                base, tok_a, {"body": "addressed hello", "to": ["peer-2"], "reply_to": 1, "kind": "proposal"}
            )
            echo_ok = (
                st_a == 200
                and '"ok": true' in body_a
                and '"to": ["peer-2"]' in body_a
                and '"reply_to": 1' in body_a
                and '"kind": "proposal"' in body_a
            )
            line = f"  A sends envelope -> HTTP {st_a}: {body_a.strip()[:200]} [reply echoes to/reply_to/kind: {echo_ok}]\n"
            print(line, end="")
            fh.write(line)

            # B recv's: the entry for A's post must carry the same three fields,
            # alongside the base shape (seq/handle/body/is_me).
            st_r, body_r = get(_k(f"{base}/recv?t={tok_b}&wait=2"), timeout=HTTP_TIMEOUT)
            recv_ok = (
                st_r == 200
                and "addressed hello" in body_r
                and '"to": ["peer-2"]' in body_r
                and '"reply_to": 1' in body_r
                and '"kind": "proposal"' in body_r
            )
            line = f"  B recv reads it -> HTTP {st_r}: {body_r.strip()[:220]} [entry carries envelope: {recv_ok}]\n"
            print(line, end="")
            fh.write(line)

            # The /trace suffix renders the envelope compactly: ->peer-2 re#1 [proposal].
            st_t, trace = get(_k(f"{base}/trace"), timeout=HTTP_TIMEOUT)
            trace_ok = st_t == 200 and "->peer-2" in trace and "re#1" in trace and "[proposal]" in trace
            line = f"  /trace suffix shows ->peer-2 re#1 [proposal]: {trace_ok}\n"
            print(line, end="")
            fh.write(line)

            # missed[] also carries the envelope: B (cursor behind) sends without
            # recv'ing A's NEXT post, so A's post shows in B's missed with fields.
            post_envelope(base, tok_a, {"body": "second from A", "to": "peer-2", "kind": "note"})  # bare-str `to`
            st_m, body_m = post(base, tok_b, "B posts blind")
            # A's "second from A" crossed; B's missed must carry it with to coerced
            # to a 1-elem list (bare string -> ["peer-2"]) and kind=note.
            missed_chunk = body_m.split('"missed"')[1] if '"missed"' in body_m else ""
            missed_ok = (
                st_m == 200
                and "second from A" in missed_chunk
                and '"to": ["peer-2"]' in missed_chunk  # bare string coerced to list
                and '"kind": "note"' in missed_chunk
            )
            line = f"  B send -> missed[] carries A's envelope (bare-str to coerced): {missed_ok}\n"
            print(line, end="")
            fh.write(line)

            # Sanitizing: a non-string `to` element is dropped; reply_to < 1 dropped.
            st_s, body_s = post_envelope(
                base, tok_a, {"body": "sanitize me", "to": ["peer-2", 99, ""], "reply_to": 0, "kind": "q\nx"}
            )
            sanitize_ok = (
                st_s == 200
                and '"to": ["peer-2"]' in body_s  # 99 (int) and "" dropped -> just peer-2
                and '"reply_to"' not in body_s  # reply_to 0 (<1) dropped entirely
                and '"kind": "q x"' in body_s  # newline in kind -> space, carried free-form
            )
            line = f"  A sends messy envelope -> HTTP {st_s}: {body_s.strip()[:200]} [bad parts dropped/normalized: {sanitize_ok}]\n"
            print(line, end="")
            fh.write(line)

            passed = echo_ok and recv_ok and trace_ok and missed_ok and sanitize_ok
            verdict = (
                "\nVERDICT: a {body,to,reply_to,kind} send is accepted; the fields echo in the reply, ride the recv "
                "entry + missed[], and render in /trace; bad parts are dropped and kind stays free-form. "
                "PASS -- envelope round-trips.\n"
                if passed
                else "\nVERDICT: send envelope behaved unexpectedly (see above). FAIL.\n"
            )
            print(verdict)
            fh.write(verdict)

            get(_k(f"{base}/unplug?t={tok_a}"), timeout=2)
            get(_k(f"{base}/unplug?t={tok_b}"), timeout=2)
        finally:
            stop_relay(proc)
    print(f"[saved] {out_path}")
    return passed


def proof_envelope_backcompat() -> bool:
    """PROOF 18 (envelope back-compat): a RAW-body send and a plain {"body":...}
    send (NO addressing keys) must each produce an entry carrying NONE of the new
    keys (no to/reply_to/kind in the send reply, the recv entry, or /trace) -- byte-
    identical to before the envelope existed. We ALSO prove the repetition kill
    stays BODY-ONLY: two IDENTICAL bodies sent with DIFFERENT `to` still count as a
    repeat (the envelope can't dodge the stall). We run a LOW RELAY_REPEAT_WINDOW
    (2) so two identical bodies trip it; generous other caps. Bounded; no hang."""
    out_path = str(Path(TDIR) / "proof_envelope_backcompat.txt")

    # REPEAT_WINDOW=2 so two identical-consecutive bodies close it (proves body-only
    # repeat kill ignores differing envelopes). Generous turn/wall caps otherwise.
    proc, base = start_relay(
        "envbc",
        {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120", "RELAY_REPEAT_WINDOW": "2", "RELAY_IDLE_WAIT": "2"},
    )
    assert base is not None
    passed = False
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)
            banner(
                fh, "PROOF 18 - ENVELOPE BACK-COMPAT (raw + {body:} sends omit the keys; repeat-kill stays body-only)"
            )

            # --- (1) RAW body send: no envelope keys anywhere ------------------
            tok = join_token(base)
            st_raw, body_raw = post(base, tok, "plain raw body")
            raw_clean = (
                st_raw == 200
                and '"ok": true' in body_raw
                and '"to"' not in body_raw
                and '"reply_to"' not in body_raw
                and '"kind"' not in body_raw
            )
            line = f"  RAW send -> HTTP {st_raw}: {body_raw.strip()[:160]} [no envelope keys in reply: {raw_clean}]\n"
            print(line, end="")
            fh.write(line)

            # --- (2) plain {"body":...} JSON, NO addressing keys ---------------
            st_j, body_j = post_envelope(base, tok, {"body": "plain json body"})
            json_clean = (
                st_j == 200
                and '"ok": true' in body_j
                and '"to"' not in body_j
                and '"reply_to"' not in body_j
                and '"kind"' not in body_j
            )
            line = (
                f"  {{body:}} send -> HTTP {st_j}: {body_j.strip()[:160]} [no envelope keys in reply: {json_clean}]\n"
            )
            print(line, end="")
            fh.write(line)

            # The recv entries + /trace for both must be free of envelope keys too.
            st_r, body_r = get(_k(f"{base}/recv?t={tok}&wait=2"), timeout=HTTP_TIMEOUT)
            st_t, trace = get(_k(f"{base}/trace"), timeout=HTTP_TIMEOUT)
            entries_clean = (
                st_r == 200
                and "plain raw body" in body_r
                and "plain json body" in body_r
                and '"to"' not in body_r
                and '"reply_to"' not in body_r
                and '"kind"' not in body_r
            )
            # /trace lines for these posts carry no addressing suffix. The header
            # and timestamps legitimately use brackets ("=== wire ... ===",
            # "[HH:MM:SS]"), so we don't blanket-ban "[" -- instead we assert there's
            # no to-arrow / reply marker, AND each body line ENDS right after the
            # body (a "[kind]" suffix, if leaked, would trail it on the same line).
            trace_clean = (
                st_t == 200
                and "->" not in trace
                and "re#" not in trace
                and "plain raw body\n" in trace  # body line ends at the body -> no suffix
                and "plain json body\n" in trace
            )
            line = f"  recv entries clean: {entries_clean}; /trace has no addressing suffix: {trace_clean}\n"
            print(line, end="")
            fh.write(line)

            # --- (3) repeat-kill is BODY-ONLY: identical body, different `to` ---
            # Two IDENTICAL bodies sent with DIFFERENT `to`. If the envelope leaked
            # into the repeat comparison they'd look distinct and NOT trip; because
            # the kill is body-only (REPEAT_WINDOW=2), the 2nd identical body closes
            # the conversation. We use a fresh pair of peers on a 2nd relay so the
            # earlier posts above don't interfere with the consecutive-dupe count.
            stop_relay(proc)
            proc2, base2 = start_relay(
                "envbc2",
                {
                    "RELAY_MAX_TURNS": "40",
                    "RELAY_MAX_SECONDS": "120",
                    "RELAY_REPEAT_WINDOW": "2",
                    "RELAY_IDLE_WAIT": "2",
                },
            )
            assert base2 is not None
            if not wait_health(base2):
                print("relay2 did not come up", file=sys.stderr)
                sys.exit(1)
            tok2 = join_token(base2)
            st_d1, _ = post_envelope(base2, tok2, {"body": "SAME body", "to": ["peer-9"]})
            st_d2, body_d2 = post_envelope(base2, tok2, {"body": "SAME body", "to": ["peer-7"]})
            # The 2nd identical body trips REPEAT_WINDOW=2 -> the conversation closes.
            # A 3rd send must now be refused (409 closed), proving the dupe counted
            # despite the differing `to`.
            st_d3, body_d3 = post(base2, tok2, "after close?")
            repeat_body_only = (
                st_d1 == 200
                and st_d2 == 200  # both identical bodies accepted (the 2nd trips+records)
                and st_d3 == 409
                and "closed" in body_d3  # 3rd refused: conversation closed by the repeat kill
            )
            line = (
                f"  two IDENTICAL bodies w/ different `to` -> d1={st_d1} d2={st_d2}; "
                f"next send d3={st_d3} ({body_d3.strip()[:80]}) [repeat-kill body-only: {repeat_body_only}]\n"
            )
            print(line, end="")
            fh.write(line)

            passed = raw_clean and json_clean and entries_clean and trace_clean and repeat_body_only
            verdict = (
                "\nVERDICT: raw + {body:} sends carry NONE of to/reply_to/kind (reply, recv entry, /trace all clean); "
                "two identical bodies with different `to` still trip the repeat kill. "
                "PASS -- envelope is omitted-when-absent and the repeat-kill stays body-only.\n"
                if passed
                else "\nVERDICT: envelope back-compat behaved unexpectedly (see above). FAIL.\n"
            )
            print(verdict)
            fh.write(verdict)

            with contextlib.suppress(Exception):
                get(_k(f"{base2}/unplug?t={tok2}"), timeout=2)
            stop_relay(proc2)
        finally:
            stop_relay(proc)
    print(f"[saved] {out_path}")
    return passed


def proof_recv_mine_filter() -> bool:
    """PROOF 19 (optional ?mine=1 recv filter): a filtering peer sees broadcasts +
    messages addressed to it + ALL system entries, but NOT others-addressed
    messages. CRUCIALLY the cursor still advances past EVERYTHING: a follow-up
    filtered recv returns idle (the hidden others-addressed message is NOT
    re-delivered). A closed signal still reaches a ?mine recv. A DEFAULT recv (no
    filter) sees everything, unchanged. Bounded throughout; no hang."""
    out_path = str(Path(TDIR) / "proof_recv_mine_filter.txt")

    proc, base = start_relay("mine", {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120", "RELAY_IDLE_WAIT": "1"})
    assert base is not None
    passed = False
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)
            banner(fh, "PROOF 19 - RECV ?mine=1 FILTER (broadcast + own-addressed + system; cursor advances past all)")

            tok_a = join_token(base)  # peer-1, the sender
            tok_b = join_token(base)  # peer-2, reads the full log (default recv)
            tok_c = join_token(base)  # peer-3, the FILTERING peer (?mine=1)

            # Drain C's join-notice backlog so the test posts below are what its
            # filtered recv evaluates (a fresh cursor starts at 0 -> would otherwise
            # return the seq-1.. join notices first).
            get(_k(f"{base}/recv?t={tok_c}&wait=1"), timeout=HTTP_TIMEOUT)

            # A posts three messages: a broadcast, one addressed to C (peer-3), and
            # one addressed to B (peer-2) -- the last is OTHERS-addressed for C.
            post(base, tok_a, "broadcast to all")
            post_envelope(base, tok_a, {"body": "for C only", "to": ["peer-3"]})
            post_envelope(base, tok_a, {"body": "for B only", "to": ["peer-2"]})

            # C's FILTERED recv: must include the broadcast + the C-addressed, must
            # EXCLUDE the B-addressed. (System entries already drained above.)
            st_c, body_c = get(_k(f"{base}/recv?t={tok_c}&wait=1&mine=1"), timeout=HTTP_TIMEOUT)
            filtered_ok = (
                st_c == 200
                and "broadcast to all" in body_c
                and "for C only" in body_c
                and "for B only" not in body_c  # others-addressed -> hidden
            )
            line = f"  C ?mine=1 recv -> HTTP {st_c}: {body_c.strip()[:200]} [broadcast+own shown, others hidden: {filtered_ok}]\n"
            print(line, end="")
            fh.write(line)

            # Cursor advanced past EVERYTHING (incl. the hidden 'for B only'): C's
            # FOLLOW-UP filtered recv must be a 200 idle heartbeat, NOT a re-delivery
            # of the skipped message. This is the read-position invariant.
            st_c2, body_c2 = get(_k(f"{base}/recv?t={tok_c}&wait=1&mine=1"), timeout=HTTP_TIMEOUT)
            cursor_advanced = st_c2 == 200 and '"idle": true' in body_c2 and "for B only" not in body_c2
            line = f"  C follow-up ?mine=1 recv -> HTTP {st_c2}: {body_c2.strip()[:160]} [idle, skipped msg NOT redelivered: {cursor_advanced}]\n"
            print(line, end="")
            fh.write(line)

            # A DEFAULT recv (no filter), peer B, must see ALL THREE messages -- the
            # filter is per-call and opt-in; the group log is unchanged for B.
            st_b, body_b = get(_k(f"{base}/recv?t={tok_b}&wait=1"), timeout=HTTP_TIMEOUT)
            default_sees_all = (
                st_b == 200 and "broadcast to all" in body_b and "for C only" in body_b and "for B only" in body_b
            )
            line = f"  B default recv (no filter) sees all three: {default_sees_all}\n"
            print(line, end="")
            fh.write(line)

            # A closed signal STILL reaches a ?mine recv. With A and B gone, C is the
            # lone peer: park a ?mine recv for C (valid token, parks on cond.wait),
            # THEN unplug C -> last-peer-out closes the room and the close wakes the
            # parked recv carrying the closed signal. (System entries are never
            # filtered, and the closed path sits below the filter regardless.)
            get(_k(f"{base}/unplug?t={tok_a}"), timeout=2)
            get(_k(f"{base}/unplug?t={tok_b}"), timeout=2)
            # Drain C's cursor first: A's + B's "left" system notices are now unread
            # past C's cursor, so without this the parked recv would return them
            # immediately instead of parking until the close. After draining, the
            # parked ?mine recv has nothing pending -> only the close releases it.
            get(_k(f"{base}/recv?t={tok_c}&wait=1&mine=1"), timeout=HTTP_TIMEOUT)
            results: dict[int, dict[str, Any]] = {}

            def _park_mine() -> None:
                t0 = time.time()
                stt, bod = get(_k(f"{base}/recv?t={tok_c}&wait=600&mine=1"), timeout=HTTP_TIMEOUT + 1)
                results[0] = {"elapsed": round(time.time() - t0, 3), "status": stt, "body": bod.strip()[:160]}

            parker = threading.Thread(target=_park_mine)
            parker.start()
            time.sleep(0.5)  # ensure the ?mine recv is genuinely parked
            get(_k(f"{base}/unplug?t={tok_c}"), timeout=2)  # last peer out -> close
            parker.join(timeout=HTTP_TIMEOUT + 3)
            r = results.get(0, {"elapsed": -1, "status": "NO-RESULT", "body": ""})
            closed_reaches_mine = r["status"] == 200 and "conversation closed" in r["body"]
            line = f"  parked C ?mine recv released after {r['elapsed']}s (status {r['status']}) <- {r['body']} [closed reaches ?mine: {closed_reaches_mine}]\n"
            print(line, end="")
            fh.write(line)

            passed = filtered_ok and cursor_advanced and default_sees_all and closed_reaches_mine
            verdict = (
                "\nVERDICT: ?mine=1 shows broadcasts + own-addressed + system entries and hides others-addressed; the "
                "cursor advances past everything (skipped msg not re-delivered); the closed signal still reaches a "
                "?mine recv; a default recv sees the full log. PASS -- ?mine filter is advisory, cursor-safe.\n"
                if passed
                else "\nVERDICT: ?mine filter behaved unexpectedly (see above). FAIL.\n"
            )
            print(verdict)
            fh.write(verdict)
        finally:
            stop_relay(proc)
    print(f"[saved] {out_path}")
    return passed


def proof_since() -> bool:
    """PROOF 20 (?since=<seq> cursor-safe replay): a ?since recv returns ONLY the
    entries with seq STRICTLY GREATER than the given seq (not <=). HEADLINE: it is
    cursor-SAFE -- it NEVER advances the server-held read position, so after a
    ?since a NORMAL recv still delivers the FULL backlog from the real cursor.
    `since` past the tip -> [] (200). And POST-CLOSE a ?since still works, returning
    the in-log 'conversation closed' entry INSIDE the array (NOT the terminal
    {"system":...} stop-object a normal recv emits). Bounded throughout; no hang."""
    out_path = str(Path(TDIR) / "proof_since.txt")

    # Defaults for windowing (RELAY_MAX_REPLAY unset) so the backlog comes back in
    # one slice; low idle wait so the "nothing new" recv heartbeat returns fast.
    proc, base = start_relay("since", {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120", "RELAY_IDLE_WAIT": "1"})
    assert base is not None
    passed = False
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)
            banner(
                fh,
                "PROOF 20 - ?since=<seq> CURSOR-SAFE REPLAY (seq>since only; never moves cursor; post-close in-array)",
            )

            tok_a = join_token(base)  # peer-1, the sender
            tok_b = join_token(base)  # peer-2, the resync peer -- never recvs until the end

            # A posts three messages. With peer-1/peer-2 join notices at seq 1/2,
            # these land at seq 3,4,5.
            post(base, tok_a, "msg one")
            post(base, tok_a, "msg two")
            post(base, tok_a, "msg three")

            # ?since=3 must return ONLY seq 4 and 5 (strictly > 3), never seq 3.
            st_s, body_s = get(_k(f"{base}/recv?t={tok_b}&since=3"), timeout=HTTP_TIMEOUT)
            arr = json.loads(body_s)
            seqs = [e.get("seq") for e in arr] if isinstance(arr, list) else []
            since_strict = st_s == 200 and isinstance(arr, list) and seqs == [4, 5] and "msg three" in body_s
            line = f"  B ?since=3 -> HTTP {st_s}: seqs={seqs} (want [4,5], strictly > 3) [{since_strict}]\n"
            print(line, end="")
            fh.write(line)

            # HEADLINE: that ?since did NOT move B's cursor. A NORMAL recv for B now
            # STILL returns the WHOLE backlog from the real cursor (0) -- joins +
            # all three msgs (seq 1..5), proving ?since was a pure peek.
            st_n, body_n = get(_k(f"{base}/recv?t={tok_b}&wait=1"), timeout=HTTP_TIMEOUT)
            full = json.loads(body_n)
            full_seqs = [e.get("seq") for e in full] if isinstance(full, list) else []
            cursor_untouched = (
                st_n == 200
                and isinstance(full, list)
                and full_seqs == [1, 2, 3, 4, 5]
                and "msg one" in body_n
                and "msg three" in body_n
            )
            line = f"  B normal recv AFTER ?since -> HTTP {st_n}: seqs={full_seqs} (want full [1..5] -- cursor NOT moved) [{cursor_untouched}]\n"
            print(line, end="")
            fh.write(line)

            # since past the tip -> [] (200). Tip is seq 5; ?since=99 is empty.
            st_p, body_p = get(_k(f"{base}/recv?t={tok_b}&since=99"), timeout=HTTP_TIMEOUT)
            past_tip = st_p == 200 and json.loads(body_p) == []
            line = f"  B ?since=99 (past tip) -> HTTP {st_p}: {body_p.strip()} (want []) [{past_tip}]\n"
            print(line, end="")
            fh.write(line)

            # POST-CLOSE: ?since must STILL work and return the in-log 'conversation
            # closed' entry INSIDE the array (not the terminal {"system":...} object).
            # We need a CLOSED room with a peer's token still LIVE -- but last-peer-out
            # close pops every peer, leaving no valid token. The turn cap closes the
            # room WITHOUT removing peers, so spin a dedicated relay with
            # RELAY_MAX_TURNS=2: two posts close it while the resync peer stays jacked.
            get(_k(f"{base}/unplug?t={tok_a}"), timeout=2)
            get(_k(f"{base}/unplug?t={tok_b}"), timeout=2)
            stop_relay(proc)

            proc2, base2 = start_relay(
                "since2", {"RELAY_MAX_TURNS": "2", "RELAY_MAX_SECONDS": "120", "RELAY_IDLE_WAIT": "1"}
            )
            assert base2 is not None
            if not wait_health(base2):
                print("relay2 did not come up", file=sys.stderr)
                sys.exit(1)
            tok_e = join_token(base2)  # sender (peer-1)
            tok_f = join_token(base2)  # resync peer (peer-2) -- token stays live post-close
            post(base2, tok_e, "first")  # turn 1
            post(base2, tok_e, "second")  # turn 2 -> trips cap -> close (peers NOT popped)
            # Confirm the room is closed: a NORMAL recv for F returns the backlog then
            # the terminal stop-object; we just check /peers reports closed.
            _, peers_body = get(_k(f"{base2}/peers"), timeout=2)
            closed_now = '"closed": true' in peers_body
            # POST-CLOSE ?since: F asks ?since=0 -> the WHOLE log incl. the
            # 'conversation closed' entry, INSIDE the array; NOT the {"system":...}
            # terminal object a normal recv would emit once drained.
            st_pc, body_pc = get(_k(f"{base2}/recv?t={tok_f}&since=0"), timeout=HTTP_TIMEOUT)
            pc = json.loads(body_pc)
            post_close_in_array = (
                st_pc == 200
                and isinstance(pc, list)  # an ARRAY, not the terminal object
                and any("conversation closed" in str(e.get("body", "")) for e in pc)
            )
            line = (
                f"  post-close ?since=0 -> HTTP {st_pc} (room closed={closed_now}): "
                f"closed-entry INSIDE array (not terminal object): {post_close_in_array}\n"
            )
            print(line, end="")
            fh.write(line)
            # And a normal recv post-close (after draining) IS the terminal object --
            # the contrast that proves ?since is historical, recv is the live signal.
            get(_k(f"{base2}/recv?t={tok_f}&wait=1"), timeout=HTTP_TIMEOUT)  # drain backlog
            st_term, body_term = get(_k(f"{base2}/recv?t={tok_f}&wait=1"), timeout=HTTP_TIMEOUT)
            term = json.loads(body_term)
            normal_is_terminal = st_term == 200 and isinstance(term, dict) and "system" in term
            line = f"  contrast: normal recv post-close -> HTTP {st_term}: {body_term.strip()[:120]} [terminal object: {normal_is_terminal}]\n"
            print(line, end="")
            fh.write(line)

            passed = since_strict and cursor_untouched and past_tip and post_close_in_array and normal_is_terminal
            verdict = (
                "\nVERDICT: ?since returns seq>since only; it NEVER advances the cursor (a normal recv after still "
                "delivers the full backlog); since past the tip is []; post-close ?since returns the closed entry "
                "INSIDE the array while a normal recv returns the terminal object. PASS -- ?since is a cursor-safe "
                "historical peek.\n"
                if passed
                else "\nVERDICT: ?since behaved unexpectedly (see above). FAIL.\n"
            )
            print(verdict)
            fh.write(verdict)
        finally:
            stop_relay(proc)
            with contextlib.suppress(Exception):
                stop_relay(proc2)  # type: ignore[possibly-undefined]
    print(f"[saved] {out_path}")
    return passed


def proof_replay_window() -> bool:
    """PROOF 21 (RELAY_MAX_REPLAY backlog windowing): with the knob at 3 and a
    backlog over 3, the FIRST recv returns the truncation OBJECT -- truncated:true,
    EXACTLY 3 entries, a next_since, a remaining count, and a hint naming the
    '?since=' escape hatch. DRAIN CONTINUITY: a plain re-run recv returns the next
    batch starting right after next_since (no gap, no dup). CROSS-CHECK: a
    ?since=next_since fetch returns the same remainder. REGRESSION GUARD: with the
    knob UNSET, the first recv on the same backlog is a BARE ARRAY (no object).
    Bounded throughout; no hang."""
    out_path = str(Path(TDIR) / "proof_replay_window.txt")

    # Windowing ON at 3. Generous turn cap so 6 posts don't close the room.
    proc, base = start_relay(
        "replaywin",
        {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120", "RELAY_IDLE_WAIT": "1", "RELAY_MAX_REPLAY": "3"},
    )
    assert base is not None
    passed = False
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)
            banner(
                fh,
                "PROOF 21 - RELAY_MAX_REPLAY WINDOWING (truncation object, drain continuity, ?since cross-check, default bare array)",
            )

            tok_a = join_token(base)  # sender (peer-1)
            tok_b = join_token(base)  # the draining peer (peer-2), reads nothing until now

            # Six body posts. With peer-1/peer-2 joins at seq 1,2 these are seq 3..8;
            # B's unread backlog from cursor 0 is the full seq 1..8 (8 raw entries).
            for i in range(1, 7):
                post(base, tok_a, f"backlog {i}")

            # FIRST recv (B): backlog is 8 raw > 3 -> truncation OBJECT, exactly 3
            # entries (seq 1,2,3), next_since=3, remaining=5, hint mentions ?since=.
            st1, b1 = get(_k(f"{base}/recv?t={tok_b}&wait=1"), timeout=HTTP_TIMEOUT)
            o1 = json.loads(b1)
            is_obj = isinstance(o1, dict) and o1.get("truncated") is True
            three = is_obj and len(o1.get("entries", [])) == 3
            first_seqs = [e.get("seq") for e in o1.get("entries", [])] if is_obj else []
            next_since = o1.get("next_since") if is_obj else None
            has_fields = is_obj and next_since == 3 and o1.get("remaining") == 5 and "?since=" in o1.get("hint", "")
            window_obj_ok = is_obj and three and first_seqs == [1, 2, 3] and has_fields
            line = (
                f"  B first recv (backlog 8, cap 3) -> HTTP {st1}: truncated={o1.get('truncated') if is_obj else 'N/A'} "
                f"entries={first_seqs} next_since={next_since} remaining={o1.get('remaining') if is_obj else 'N/A'} "
                f"hint_has_since={'?since=' in o1.get('hint', '') if is_obj else False} [{window_obj_ok}]\n"
            )
            print(line, end="")
            fh.write(line)

            # DRAIN CONTINUITY: a plain re-run recv resumes at next_since+1 (seq 4),
            # the NEXT 3 (seq 4,5,6) -- no gap (doesn't skip 4), no dup (doesn't
            # repeat 3). Still truncated (2 remain).
            st2, b2 = get(_k(f"{base}/recv?t={tok_b}&wait=1"), timeout=HTTP_TIMEOUT)
            o2 = json.loads(b2)
            second_seqs = [e.get("seq") for e in o2.get("entries", [])] if isinstance(o2, dict) else []
            drain_ok = (
                st2 == 200
                and isinstance(o2, dict)
                and o2.get("truncated") is True
                and second_seqs == [4, 5, 6]
                and o2.get("next_since") == 6
                and o2.get("remaining") == 2
            )
            line = f"  B re-run recv (drain) -> HTTP {st2}: entries={second_seqs} (want [4,5,6], no gap/dup) next_since={o2.get('next_since') if isinstance(o2, dict) else 'N/A'} [{drain_ok}]\n"
            print(line, end="")
            fh.write(line)

            # ?since=next_since CROSS-CHECK: fetching ?since=3 (the FIRST window's
            # next_since) returns the WHOLE remainder seq 4..8 in one slice (?since
            # is not windowed) -- proving next_since is a faithful resume handle.
            st_x, bx = get(_k(f"{base}/recv?t={tok_b}&since=3"), timeout=HTTP_TIMEOUT)
            arr_x = json.loads(bx)
            xseqs = [e.get("seq") for e in arr_x] if isinstance(arr_x, list) else []
            cross_ok = st_x == 200 and isinstance(arr_x, list) and xseqs == [4, 5, 6, 7, 8]
            line = f"  ?since=3 (first next_since) cross-check -> HTTP {st_x}: seqs={xseqs} (want remainder [4..8]) [{cross_ok}]\n"
            print(line, end="")
            fh.write(line)
            stop_relay(proc)

            # COMPOSE WITH ?mine (no regress to proof_recv_mine_filter): a windowed
            # batch whose first N raw entries are ALL others-addressed -> the ?mine
            # filter empties what's SHOWN, but recv must STILL return the truncation
            # OBJECT (never []) AND the cursor must advance over the whole window, so
            # those hidden entries are skipped, not re-queued. Fresh relay, cap 2:
            # peer-1 (E) sends 3 messages all addressed to peer-2 (G); peer-3 (M)
            # filters with ?mine and is not a recipient.
            proc3, base3 = start_relay(
                "replaymine",
                {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120", "RELAY_IDLE_WAIT": "1", "RELAY_MAX_REPLAY": "2"},
            )
            assert base3 is not None
            if not wait_health(base3):
                print("relay3 did not come up", file=sys.stderr)
                sys.exit(1)
            tok_e = join_token(base3)  # peer-1, sender
            join_token(base3)  # peer-2 -- the (real) recipient every message is addressed to
            tok_m = join_token(base3)  # peer-3, the FILTERING non-recipient
            # Drain M to a CONFIRMED idle (loop until we get the idle heartbeat, not
            # an array) so its cursor is at the tip deterministically -- the staggered
            # joins can otherwise span more than one recv. The idle object's `cursor`
            # is M's exact read position right before the posts below.
            mcur_before = None
            for _ in range(10):
                r_body = get(_k(f"{base3}/recv?t={tok_m}&wait=1"), timeout=HTTP_TIMEOUT)[1]
                r_obj = json.loads(r_body)
                if isinstance(r_obj, dict) and r_obj.get("idle") is True:
                    mcur_before = r_obj.get("cursor")
                    break
            for _ in range(3):
                post_envelope(base3, tok_e, {"body": "for G only", "to": ["peer-2"]})
            # M's ?mine recv: window is the first 2 (both G-addressed) -> shown empties,
            # but we MUST get the truncation object (truncated:true, entries==[]), and
            # the cursor must have advanced past the 2 windowed entries.
            st_m, bm = get(_k(f"{base3}/recv?t={tok_m}&wait=1&mine=1"), timeout=HTTP_TIMEOUT)
            om = json.loads(bm)
            mine_obj_ok = (
                st_m == 200
                and isinstance(om, dict)
                and om.get("truncated") is True
                and om.get("entries") == []  # all windowed entries hidden by ?mine
                and om.get("next_since") == mcur_before + 2  # cursor moved over the 2-entry window
            )
            line = f"  ?mine + windowing (all-hidden window) -> HTTP {st_m}: truncated={om.get('truncated') if isinstance(om, dict) else 'N/A'} entries={om.get('entries') if isinstance(om, dict) else 'N/A'} next_since={om.get('next_since') if isinstance(om, dict) else 'N/A'} (cursor advanced past hidden window, object not []) [{mine_obj_ok}]\n"
            print(line, end="")
            fh.write(line)
            stop_relay(proc3)

            # REGRESSION GUARD: same backlog, knob UNSET -> first recv is a BARE
            # ARRAY (all 8 entries), NOT a truncation object. Zero regression.
            proc2, base2 = start_relay(
                "replaynocap", {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120", "RELAY_IDLE_WAIT": "1"}
            )
            assert base2 is not None
            if not wait_health(base2):
                print("relay2 did not come up", file=sys.stderr)
                sys.exit(1)
            tok_c = join_token(base2)  # sender
            tok_d = join_token(base2)  # drainer
            for i in range(1, 7):
                post(base2, tok_c, f"backlog {i}")
            st_d, bd = get(_k(f"{base2}/recv?t={tok_d}&wait=1"), timeout=HTTP_TIMEOUT)
            od = json.loads(bd)
            bare_array = st_d == 200 and isinstance(od, list) and len(od) == 8
            line = f"  default (knob unset) first recv on same backlog -> HTTP {st_d}: type={'array' if isinstance(od, list) else 'object'} len={len(od) if isinstance(od, list) else 'N/A'} (want bare array of 8) [{bare_array}]\n"
            print(line, end="")
            fh.write(line)

            passed = window_obj_ok and drain_ok and cross_ok and mine_obj_ok and bare_array
            verdict = (
                "\nVERDICT: RELAY_MAX_REPLAY=3 windows an 8-entry backlog into a truncation OBJECT (truncated:true, "
                "exactly 3 entries, next_since, remaining, hint naming ?since=); a plain re-run recv drains the next "
                "batch with no gap/dup; ?since=next_since returns the remainder; ?mine composes (an all-hidden window "
                "still returns the object, cursor advanced past it); with the knob unset the same backlog is a BARE "
                "ARRAY. PASS -- windowing composes and the default is unchanged.\n"
                if passed
                else "\nVERDICT: backlog windowing behaved unexpectedly (see above). FAIL.\n"
            )
            print(verdict)
            fh.write(verdict)
        finally:
            stop_relay(proc)
            with contextlib.suppress(Exception):
                stop_relay(proc2)  # type: ignore[possibly-undefined]
            with contextlib.suppress(Exception):
                stop_relay(proc3)  # type: ignore[possibly-undefined]
    print(f"[saved] {out_path}")
    return passed


def proof_floor_grant_and_queue() -> bool:
    """PROOF 22 (advisory floor -- grant + FIFO queue, anti-livelock): three peers
    A,B,C. A op=acquire -> granted (is_mine, no queue). B,C op=acquire -> queued at
    position 1 and 2 (A still holds). The holder + the waits are visible to all
    (op=status from C, and on a quiet recv idle heartbeat: floor_holder=peer-1,
    floor_wait reflecting the queue ahead). A op=release -> B is promoted (is_mine);
    B op=release -> C is promoted. FIFO fairness: the slow 3rd peer is GUARANTEED a
    turn, which is the whole point (it kills the fastest-poster ?last= livelock).
    Lease ON but long (>> the test) so ONLY explicit release moves the floor here.
    Bounded throughout; no hang."""
    out_path = str(Path(TDIR) / "proof_floor_grant_and_queue.txt")
    # Long lease + short idle so the idle heartbeat returns fast but the lease never
    # lapses mid-test (this proof exercises explicit release, not expiry).
    proc, base = start_relay(
        "floorgq",
        {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120", "RELAY_FLOOR_LEASE": "60", "RELAY_IDLE_WAIT": "1"},
    )
    assert base is not None
    passed = False
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)
            banner(fh, "PROOF 22 - FLOOR GRANT + FIFO QUEUE (first-waiter-wins; slow peer guaranteed a turn)")

            tok_a = join_token(base)  # peer-1
            tok_b = join_token(base)  # peer-2
            tok_c = join_token(base)  # peer-3

            # A acquires -> granted: is_mine true, holder peer-1, empty queue.
            st_a, a = floor(base, tok_a, "acquire")
            a_granted = (
                st_a == 200 and a.get("is_mine") is True and a.get("floor_holder") == "peer-1" and a.get("queue") == []
            )
            line = (
                f"  A acquire -> HTTP {st_a}: holder={a.get('floor_holder')} "
                f"is_mine={a.get('is_mine')} queue={a.get('queue')} [granted: {a_granted}]\n"
            )
            print(line, end="")
            fh.write(line)

            # B then C acquire -> queued behind A at positions 1 and 2 (NOT granted).
            st_b, b = floor(base, tok_b, "acquire")
            b_queued = (
                st_b == 200
                and b.get("is_mine") is False
                and b.get("floor_holder") == "peer-1"
                and b.get("position") == 1
            )
            line = (
                f"  B acquire -> HTTP {st_b}: holder={b.get('floor_holder')} "
                f"is_mine={b.get('is_mine')} position={b.get('position')} [queued@1: {b_queued}]\n"
            )
            print(line, end="")
            fh.write(line)

            st_c, c = floor(base, tok_c, "acquire")
            c_queued = (
                st_c == 200
                and c.get("is_mine") is False
                and c.get("position") == 2
                and c.get("queue")
                == [
                    "peer-2",
                    "peer-3",
                ]
            )
            line = (
                f"  C acquire -> HTTP {st_c}: holder={c.get('floor_holder')} "
                f"position={c.get('position')} queue={c.get('queue')} [queued@2: {c_queued}]\n"
            )
            print(line, end="")
            fh.write(line)

            # Holder + waits are visible on a QUIET recv idle heartbeat too (the
            # connection-level turn fields ride the idle payload). C is 2nd in line,
            # so from C's view floor_holder=peer-1, floor_is_mine=false, wait=1
            # (one ahead: peer-2). C's FIRST recv drains its join-backlog (a plain
            # array), so we re-run recv until we get the idle OBJECT, then assert the
            # turn fields on it. This proves the turn state surfaces WITHOUT /floor.
            body_idle = ""
            for _ in range(6):
                st_idle, body_idle = get(_k(f"{base}/recv?t={tok_c}&wait=1"), timeout=HTTP_TIMEOUT)
                if st_idle == 200 and '"idle": true' in body_idle:
                    break
            idle_shows = (
                '"idle": true' in body_idle
                and '"floor_holder": "peer-1"' in body_idle
                and '"floor_is_mine": false' in body_idle
                and '"floor_wait": 1' in body_idle
            )
            line = (
                f"  C recv idle heartbeat surfaces turn state: "
                f"{body_idle.strip()[:170]} [holder+wait visible: {idle_shows}]\n"
            )
            print(line, end="")
            fh.write(line)

            # A releases -> FIFO head (B) is promoted to holder.
            st_ra, ra = floor(base, tok_a, "release")
            b_promoted = st_ra == 200 and ra.get("floor_holder") == "peer-2"
            # Confirm from B's own perspective: B now holds the floor.
            st_bs, bs = floor(base, tok_b, "status")
            b_is_holder = st_bs == 200 and bs.get("is_mine") is True and bs.get("floor_holder") == "peer-2"
            line = (
                f"  A release -> holder now {ra.get('floor_holder')} [B promoted: {b_promoted}]; "
                f"B status is_mine={bs.get('is_mine')} [B holds: {b_is_holder}]\n"
            )
            print(line, end="")
            fh.write(line)

            # B releases -> C (the slow 3rd peer) is finally promoted -> its turn.
            st_rb, rb = floor(base, tok_b, "release")
            c_promoted = st_rb == 200 and rb.get("floor_holder") == "peer-3"
            st_cs, cs = floor(base, tok_c, "status")
            c_is_holder = st_cs == 200 and cs.get("is_mine") is True and cs.get("queue") == []
            line = (
                f"  B release -> holder now {rb.get('floor_holder')} [C promoted: {c_promoted}]; "
                f"C status is_mine={cs.get('is_mine')} queue={cs.get('queue')} [C holds: {c_is_holder}]\n"
            )
            print(line, end="")
            fh.write(line)

            passed = (
                a_granted
                and b_queued
                and c_queued
                and idle_shows
                and b_promoted
                and b_is_holder
                and c_promoted
                and c_is_holder
            )
            verdict = (
                "\nVERDICT: A granted; B,C queued FIFO at 1,2; holder+waits visible via status AND the recv idle "
                "heartbeat; release promoted B then C in order -- the slow 3rd peer got its guaranteed turn. "
                "PASS -- advisory floor is first-waiter-wins (anti-livelock).\n"
                if passed
                else "\nVERDICT: floor grant/queue behaved unexpectedly (see above). FAIL.\n"
            )
            print(verdict)
            fh.write(verdict)

            for t in (tok_a, tok_b, tok_c):
                with contextlib.suppress(Exception):
                    get(_k(f"{base}/unplug?t={t}"), timeout=2)
        finally:
            stop_relay(proc)
    print(f"[saved] {out_path}")
    return passed


def proof_floor_lease_expiry() -> bool:
    """PROOF 23 (floor lease expiry -- lease clock alone hands off the turn): a SHORT
    RELAY_FLOOR_LEASE. A acquires the floor and NEVER releases (a hung holder). B
    queues behind A. Within ~lease+slack, WITHOUT any release call, the lease lapses
    and B becomes the holder purely on the lease clock -- proven both via B's
    op=status and via B's recv idle heartbeat (floor_is_mine flips true). This is the
    anti-livelock backstop: a holder that hangs cannot pin the floor forever. We keep
    BOTH peers alive (periodic recv) so the REAPER never fires -- the handoff here is
    the LEASE, not a peer drop (that is proof_floor_holder_reaped). Bounded; no hang."""
    out_path = str(Path(TDIR) / "proof_floor_lease_expiry.txt")
    # Short lease (2s) << peer timeout (default 90s) so the lease lapses while both
    # peers are still very much alive. Short idle so heartbeats return fast.
    proc, base = start_relay(
        "floorlease",
        {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120", "RELAY_FLOOR_LEASE": "2", "RELAY_IDLE_WAIT": "1"},
    )
    assert base is not None
    passed = False
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)
            banner(fh, "PROOF 23 - FLOOR LEASE EXPIRY (hung holder auto-released; waiter promoted on the clock alone)")

            tok_a = join_token(base)  # peer-1
            tok_b = join_token(base)  # peer-2

            st_a, a = floor(base, tok_a, "acquire")
            a_holds = st_a == 200 and a.get("is_mine") is True and a.get("floor_holder") == "peer-1"
            st_b, b = floor(base, tok_b, "acquire")
            b_queued = st_b == 200 and b.get("is_mine") is False and b.get("position") == 1
            line = (
                f"  A acquire -> holder={a.get('floor_holder')} [A holds: {a_holds}]; "
                f"B acquire -> position={b.get('position')} [B queued: {b_queued}]\n"
            )
            print(line, end="")
            fh.write(line)
            line = "  A now HANGS (never releases). Waiting out the lease -- NO release call is made...\n"
            print(line, end="")
            fh.write(line)

            # Poll B's view until the lease lapses and B becomes holder -- WITHOUT
            # ever calling release. We drive B's OWN recv each turn: it both keeps B
            # alive (last_seen refreshes on arrival -> never reaped) AND drains B's
            # join-backlog so a later recv is a true idle heartbeat. We also keep A
            # alive so this is the LEASE handing off, not the reaper. Bounded window
            # of ~lease + a couple sweep/slack seconds. We accept the flip when B's
            # recv idle heartbeat itself shows floor_is_mine:true (turn handed over by
            # the lease clock, surfaced to a quiet peer with no send).
            b_became_holder = False
            idle_flip = False
            deadline = time.time() + 8  # 2s lease + slack; well under any cap
            while time.time() < deadline:
                get(_k(f"{base}/recv?t={tok_a}&wait=1"), timeout=HTTP_TIMEOUT)  # keep A present
                st_i, body_i = get(_k(f"{base}/recv?t={tok_b}&wait=1"), timeout=HTTP_TIMEOUT)
                st_bs, bs = floor(base, tok_b, "status")
                if st_bs == 200 and bs.get("is_mine") is True and bs.get("floor_holder") == "peer-2":
                    b_became_holder = True
                    # The idle heartbeat (when B's backlog is drained) shows the flip.
                    idle_flip = (
                        st_i == 200
                        and '"idle": true' in body_i
                        and '"floor_holder": "peer-2"' in body_i
                        and '"floor_is_mine": true' in body_i
                    )
                    if not idle_flip:
                        # One more recv now that the backlog is surely drained.
                        st_i, body_i = get(_k(f"{base}/recv?t={tok_b}&wait=1"), timeout=HTTP_TIMEOUT)
                        idle_flip = (
                            st_i == 200
                            and '"idle": true' in body_i
                            and '"floor_holder": "peer-2"' in body_i
                            and '"floor_is_mine": true' in body_i
                        )
                    line = (
                        f"  lease lapsed -> B status is_mine={bs.get('is_mine')} "
                        f"holder={bs.get('floor_holder')} (NO release was called) [promoted: {b_became_holder}]\n"
                    )
                    print(line, end="")
                    fh.write(line)
                    line = (
                        f"  B recv idle heartbeat: {body_i.strip()[:150]} [floor_is_mine flipped true: {idle_flip}]\n"
                    )
                    print(line, end="")
                    fh.write(line)
                    break
                time.sleep(0.3)
            if not b_became_holder:
                line = "  B did NOT become holder within the lease window (FAIL)\n"
                print(line, end="")
                fh.write(line)

            passed = a_holds and b_queued and b_became_holder and idle_flip
            verdict = (
                "\nVERDICT: a holder that never released was auto-released by the lease, and the queued waiter became "
                "holder on the lease clock ALONE (no release call, both peers still alive). "
                "PASS -- lease expiry guarantees the turn advances.\n"
                if passed
                else "\nVERDICT: floor lease expiry behaved unexpectedly (see above). FAIL.\n"
            )
            print(verdict)
            fh.write(verdict)

            for t in (tok_a, tok_b):
                with contextlib.suppress(Exception):
                    get(_k(f"{base}/unplug?t={t}"), timeout=2)
        finally:
            stop_relay(proc)
    print(f"[saved] {out_path}")
    return passed


def proof_floor_advisory_nonblocking() -> bool:
    """PROOF 24 (floor is ADVISORY + default-off back-compat): two parts.

      (1) ADVISORY -- a held floor NEVER refuses a send. On a relay with the lease
          ON, A op=acquire (holds the floor). A DIFFERENT peer B that NEVER called
          /floor does a plain /send -> 200 (never refused), and B's send reply still
          carries floor_holder:"peer-1" + floor_is_mine:false (it only REPORTS whose
          turn it is). No floor state can permanently refuse a send.

      (2) DEFAULT-OFF -- a SECOND relay with RELAY_FLOOR_LEASE=0: /floor op=status
          still answers but floor_holder is null, and a recv idle heartbeat OMITS or
          NULLS the turn fields meaningfully (floor_holder:null, floor_is_mine:false,
          floor_wait:0) -- nothing populated, byte-for-byte legacy for non-callers.

    Bounded throughout; no hang."""
    out_path = str(Path(TDIR) / "proof_floor_advisory_nonblocking.txt")
    proc, base = start_relay(
        "flooradv",
        {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120", "RELAY_FLOOR_LEASE": "60", "RELAY_IDLE_WAIT": "1"},
    )
    assert base is not None
    passed = False
    proc2: subprocess.Popen[str] | None = None
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)
            banner(fh, "PROOF 24 - FLOOR ADVISORY (send never refused) + DEFAULT-OFF back-compat")

            # --- (1) A holds the floor; B (never touched /floor) still posts ----
            tok_a = join_token(base)  # peer-1
            tok_b = join_token(base)  # peer-2
            st_a, a = floor(base, tok_a, "acquire")
            a_holds = st_a == 200 and a.get("is_mine") is True and a.get("floor_holder") == "peer-1"
            line = f"  A acquire -> holder={a.get('floor_holder')} [A holds: {a_holds}]\n"
            print(line, end="")
            fh.write(line)

            turns_before = peers_turns(base)
            st_send, body_send = post(base, tok_b, "B posts despite not holding the floor")
            b_posted = st_send == 200 and '"ok": true' in body_send
            turns_after = peers_turns(base)
            appended = turns_after == turns_before + 1
            # B's send reply REPORTS the floor (advisory): holder peer-1, not mine.
            reply_reports = '"floor_holder": "peer-1"' in body_send and '"floor_is_mine": false' in body_send
            line = f"  B plain send (A holds floor) -> HTTP {st_send}: {body_send.strip()[:180]}\n"
            print(line, end="")
            fh.write(line)
            line = (
                f"    [send accepted: {b_posted}; turns {turns_before}->{turns_after} appended: {appended}; "
                f"reply reports holder peer-1 + not-mine: {reply_reports}]\n"
            )
            print(line, end="")
            fh.write(line)

            advisory_ok = a_holds and b_posted and appended and reply_reports

            # --- (2) DEFAULT-OFF: a second relay with the lease at 0 -------------
            proc2, base2 = start_relay(
                "flooroff",
                {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120", "RELAY_FLOOR_LEASE": "0", "RELAY_IDLE_WAIT": "1"},
            )
            assert base2 is not None
            if not wait_health(base2):
                print("relay2 did not come up", file=sys.stderr)
                sys.exit(1)
            tok_off = join_token(base2)  # peer-1 on the off relay
            # /floor status still answers, but the floor is open (holder null).
            st_off, off = floor(base2, tok_off, "status")
            status_null = st_off == 200 and off.get("ok") is True and off.get("floor_holder") is None
            line = (
                f"  [lease=0 relay] /floor status -> HTTP {st_off}: holder={off.get('floor_holder')} "
                f"queue={off.get('queue')} [answers, holder null: {status_null}]\n"
            )
            print(line, end="")
            fh.write(line)

            # A recv idle heartbeat: turn fields present-but-inert (holder null,
            # is_mine false, wait 0) -- nothing populated. Default-off = legacy. The
            # first recv drains the join-backlog (array), so loop to the idle OBJECT.
            body_io = ""
            for _ in range(6):
                st_io, body_io = get(_k(f"{base2}/recv?t={tok_off}&wait=1"), timeout=HTTP_TIMEOUT)
                if st_io == 200 and '"idle": true' in body_io:
                    break
            idle_inert = (
                '"idle": true' in body_io
                and '"floor_holder": null' in body_io
                and '"floor_is_mine": false' in body_io
                and '"floor_wait": 0' in body_io
            )
            line = (
                f"  [lease=0 relay] recv idle heartbeat: {body_io.strip()[:170]} "
                f"[turn fields inert (null/false/0): {idle_inert}]\n"
            )
            print(line, end="")
            fh.write(line)

            default_off_ok = status_null and idle_inert

            passed = advisory_ok and default_off_ok
            verdict = (
                "\nVERDICT: a held floor NEVER refused B's plain send (it appended; the reply only REPORTED holder "
                "peer-1); and with RELAY_FLOOR_LEASE=0 /floor status answers holder:null while the recv idle "
                "heartbeat carries inert turn fields. PASS -- floor is advisory + default-off back-compatible.\n"
                if passed
                else "\nVERDICT: floor advisory/default-off behaved unexpectedly (see above). FAIL.\n"
            )
            print(verdict)
            fh.write(verdict)

            for t in (tok_a, tok_b):
                with contextlib.suppress(Exception):
                    get(_k(f"{base}/unplug?t={t}"), timeout=2)
            with contextlib.suppress(Exception):
                get(_k(f"{base2}/unplug?t={tok_off}"), timeout=2)
        finally:
            stop_relay(proc)
            with contextlib.suppress(Exception):
                stop_relay(proc2)  # type: ignore[possibly-undefined]
    print(f"[saved] {out_path}")
    return passed


def proof_floor_holder_reaped() -> bool:
    """PROOF 25 (floor holder reaped -- dead holder clears the floor under the lock):
    SHORT RELAY_PEER_TIMEOUT, LONGER RELAY_FLOOR_LEASE (so it is the REAPER, not the
    lease, that frees the floor here). A acquires the floor then goes SILENT (never
    polls/sends again). B queues behind A and KEEPS polling (so B is never reaped).
    Within the reap window the reaper drops A -- '/trace' shows 'peer-1 left (timed
    out)' -- AND, in the SAME critical section as the holder-pop, the floor advances
    to B: B becomes holder. Proves a DEAD holder cannot pin the floor (the reaper
    holder-pop clears/advances it under the lock). Room mode so /trace is readable.
    Bounded; no hang."""
    out_path = str(Path(TDIR) / "proof_floor_holder_reaped.txt")
    sd = tempfile.mkdtemp(prefix="wire-floorreap-")
    room = "floorreap"
    passed = False
    proc: subprocess.Popen[str] | None = None
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            banner(fh, "PROOF 25 - FLOOR HOLDER REAPED (dead holder cleared; queued waiter promoted under the lock)")
            # Short peer timeout (2s) so the silent holder is reaped fast; LONG floor
            # lease (60s) so the lease can't be what frees the floor -- it must be the
            # reaper's holder-pop. Generous caps so only the reaper ends nothing else.
            proc, base = start_relay(
                "floorreap",
                {
                    "RELAY_MAX_TURNS": "40",
                    "RELAY_MAX_SECONDS": "120",
                    "RELAY_PEER_TIMEOUT": "2",
                    "RELAY_FLOOR_LEASE": "60",
                    "RELAY_IDLE_WAIT": "1",
                },
                room=room,
                statedir=sd,
            )
            assert base is not None
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)

            tok_a = join_token(base)  # peer-1 -- will hold then go silent
            tok_b = join_token(base)  # peer-2 -- queues + keeps polling

            st_a, a = floor(base, tok_a, "acquire")
            a_holds = st_a == 200 and a.get("is_mine") is True and a.get("floor_holder") == "peer-1"
            st_b, b = floor(base, tok_b, "acquire")
            b_queued = st_b == 200 and b.get("is_mine") is False and b.get("position") == 1
            line = (
                f"  A acquire -> holder={a.get('floor_holder')} [A holds: {a_holds}]; "
                f"B acquire -> position={b.get('position')} [B queued: {b_queued}]\n"
            )
            print(line, end="")
            fh.write(line)
            line = (
                "  A goes SILENT (holds floor, never polls). B keeps polling. "
                "Reaper must drop A AND advance the floor to B...\n"
            )
            print(line, end="")
            fh.write(line)

            # Keep B alive across the reap window (B's recv refreshes its last_seen
            # on arrival). Watch for BOTH: A's 'timed out' line in /trace AND the
            # floor advancing to B -- they happen in the same reaper critical section.
            a_reaped_line = False
            b_became_holder = False
            deadline = time.time() + 10  # 2s timeout + sweep + slack
            while time.time() < deadline:
                get(_k(f"{base}/recv?t={tok_b}&wait=1"), timeout=HTTP_TIMEOUT)
                _, tr = get(_k(f"{base}/trace"), timeout=HTTP_TIMEOUT)
                st_bs, bs = floor(base, tok_b, "status")
                if "peer-1 left (timed out)" in tr and st_bs == 200 and bs.get("is_mine") is True:
                    a_reaped_line = True
                    b_became_holder = bs.get("floor_holder") == "peer-2"
                    line = (
                        f"  /trace shows 'peer-1 left (timed out)': {a_reaped_line}; "
                        f"B status holder={bs.get('floor_holder')} is_mine={bs.get('is_mine')} "
                        f"[B promoted by reaper: {b_became_holder}]\n"
                    )
                    print(line, end="")
                    fh.write(line)
                    break
                time.sleep(0.3)
            if not b_became_holder:
                line = "  reaper did NOT both drop A and promote B within the window (FAIL)\n"
                print(line, end="")
                fh.write(line)

            passed = a_holds and b_queued and a_reaped_line and b_became_holder
            verdict = (
                "\nVERDICT: the silent floor-holder was reaped ('peer-1 left (timed out)') and the queued waiter B "
                "became holder in the SAME reaper sweep -- a dead holder cannot pin the floor. "
                "PASS -- the reaper holder-pop clears/advances the floor under the lock.\n"
                if passed
                else "\nVERDICT: floor holder-reaped behaved unexpectedly (see above). FAIL.\n"
            )
            print(verdict)
            fh.write(verdict)

            with contextlib.suppress(Exception):
                get(_k(f"{base}/unplug?t={tok_b}"), timeout=2)
        finally:
            if proc is not None:
                stop_relay(proc)
            shutil.rmtree(sd, ignore_errors=True)
    print(f"[saved] {out_path}")
    return passed


def proof_exclude_me() -> bool:
    """PROOF 28 (optional ?exclude_me=1 recv filter): a peer that hides its OWN echo
    still sees everyone else's posts and ALL system entries, but not its own. A
    PLAIN recv sees the full log (both peers' posts). CRUCIALLY the cursor still
    advances past the caller's own skipped post: a follow-up PLAIN recv does NOT
    re-deliver it (the read-position invariant, same as ?mine=1). Bounded; no hang."""
    out_path = str(Path(TDIR) / "proof_exclude_me.txt")

    proc, base = start_relay("excludeme", {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120", "RELAY_IDLE_WAIT": "1"})
    assert base is not None
    passed = False
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)
            banner(fh, "PROOF 28 - RECV ?exclude_me=1 FILTER (others + system shown, own echo hidden; cursor advances)")

            tok_a = join_token(base)  # peer-1, the filtering peer
            tok_b = join_token(base)  # peer-2, the other speaker / full-log reader

            # Peer-A drains its OWN backlog first (the seq-1/2 join notices for A and
            # B) so its exclude_me recv below evaluates only the tail we stage next --
            # a fresh cursor starts at 0 and would otherwise return those join notices
            # first. (B is NOT drained; its full-log read below sees everything.)
            get(_k(f"{base}/recv?t={tok_a}&wait=1"), timeout=HTTP_TIMEOUT)

            # A sends, then B sends, then a THIRD peer jacks in -- that join emits a
            # fresh "peer-3 joined" SYSTEM notice that lands UNREAD in A's tail. So the
            # tail past A's cursor is now: A's own post, B's post, peer-3's join
            # notice. This lets the one filtered recv assert all three carve-outs at
            # once: own-post hidden, other-peer-post shown, system-notice always shown.
            post(base, tok_a, "echo from A")
            post(base, tok_b, "reply from B")
            tok_c = join_token(base)  # peer-3 -> emits a system join notice into the tail

            # A's ?exclude_me=1 recv: must INCLUDE B's post + the (system) join
            # notice, and EXCLUDE A's own "echo from A".
            st_a, body_a = get(_k(f"{base}/recv?t={tok_a}&wait=1&exclude_me=1"), timeout=HTTP_TIMEOUT)
            saw_system = "joined" in body_a  # the "peer-3 joined" system notice
            excluded_ok = (
                st_a == 200
                and "reply from B" in body_a  # other peer's post -> shown
                and saw_system  # system notice -> always passes exclude_me
                and "echo from A" not in body_a  # own post -> hidden
            )
            line = (
                f"  A ?exclude_me=1 recv -> HTTP {st_a}: {body_a.strip()[:220]} "
                f"[others+system shown, own echo hidden: {excluded_ok}]\n"
            )
            print(line, end="")
            fh.write(line)

            # Cursor advanced past EVERYTHING (incl. the hidden 'echo from A'): A's
            # FOLLOW-UP PLAIN recv (no filter) must be a 200 idle heartbeat, NOT a
            # re-delivery of A's own skipped post. This is the read-position invariant.
            st_a2, body_a2 = get(_k(f"{base}/recv?t={tok_a}&wait=1"), timeout=HTTP_TIMEOUT)
            cursor_advanced = st_a2 == 200 and '"idle": true' in body_a2 and "echo from A" not in body_a2
            line = (
                f"  A follow-up PLAIN recv -> HTTP {st_a2}: {body_a2.strip()[:160]} "
                f"[idle, own skipped post NOT redelivered: {cursor_advanced}]\n"
            )
            print(line, end="")
            fh.write(line)

            # A PLAIN recv (no filter), peer B, sees the FULL log -- both A's and B's
            # posts. The filter is per-call and opt-in; the group log is unchanged.
            st_b, body_b = get(_k(f"{base}/recv?t={tok_b}&wait=1"), timeout=HTTP_TIMEOUT)
            plain_sees_both = st_b == 200 and "echo from A" in body_b and "reply from B" in body_b
            line = f"  B plain recv (no filter) sees both posts: {plain_sees_both}\n"
            print(line, end="")
            fh.write(line)

            passed = excluded_ok and cursor_advanced and plain_sees_both
            verdict = (
                "\nVERDICT: ?exclude_me=1 hides the caller's own posts while still delivering other peers' posts and ALL "
                "system notices; the cursor advances past the skipped own-post (a plain recv does not re-deliver it); a "
                "plain recv sees the full log. PASS -- ?exclude_me filter is advisory, cursor-safe.\n"
                if passed
                else "\nVERDICT: ?exclude_me filter behaved unexpectedly (see above). FAIL.\n"
            )
            print(verdict)
            fh.write(verdict)

            for t in (tok_a, tok_b, tok_c):
                with contextlib.suppress(Exception):
                    get(_k(f"{base}/unplug?t={t}"), timeout=2)
        finally:
            stop_relay(proc)
    print(f"[saved] {out_path}")
    return passed


def proof_caught_up_send() -> bool:
    """PROOF 29 (caught_up on the /send 200 reply): the send reply now carries
    `caught_up` -- whether all OTHER current peers have read the message JUST posted.
    A posts while B is behind -> the send reply's caught_up is FALSE; after B recv's
    (its cursor advances past A's post), A posts AGAIN and the reply's caught_up is
    TRUE (everyone else has now caught up to A's latest). This is the same predicate
    the idle heartbeat reports, surfaced on the send round-trip itself so the sender
    learns its message's read state without a follow-up recv. Bounded; no hang."""
    out_path = str(Path(TDIR) / "proof_caught_up_send.txt")

    proc, base = start_relay("caughtup", {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120", "RELAY_IDLE_WAIT": "1"})
    assert base is not None
    passed = False
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)
            banner(fh, "PROOF 29 - caught_up ON /send REPLY (false while a peer is behind; true once all others read)")

            tok_a = join_token(base)  # peer-1, the sender
            tok_b = join_token(base)  # peer-2, the other peer whose read state drives caught_up

            # A posts. B has NOT read anything yet (its cursor is behind A's new
            # entry), so the send reply's caught_up must be FALSE -- B has not seen
            # A's just-posted message. We parse the JSON reply and read the bool.
            st1, body1 = post(base, tok_a, "decision: ship it")
            reply1 = json.loads(body1)
            caught_false = st1 == 200 and reply1.get("caught_up") is False
            line = (
                f"  A send (B unread) -> HTTP {st1}: caught_up={reply1.get('caught_up')!r} "
                f"[false while B is behind: {caught_false}]\n"
            )
            print(line, end="")
            fh.write(line)

            # B recv's -- this advances B's cursor PAST A's post (recv is the only
            # cursor mover). Now every OTHER current peer has read A's latest.
            st_b, bb = get(_k(f"{base}/recv?t={tok_b}&wait=2"), timeout=HTTP_TIMEOUT)
            b_saw = st_b == 200 and "decision: ship it" in bb
            line = f"  B recv (reads A's post) -> HTTP {st_b}: {bb.strip()[:120]} [saw A: {b_saw}]\n"
            print(line, end="")
            fh.write(line)

            # A posts AGAIN. caught_up keys on the caller's LATEST authored entry, so
            # even though B is current with A's FIRST post, this new one is unread ->
            # the send reply's caught_up must be FALSE again. (This is why we cannot
            # assert the TRUE case via a fresh send -- any new post is born unread; the
            # true branch is read off the idle heartbeat below, same predicate.)
            st2, body2 = post(base, tok_a, "follow-up: rollout at noon")
            reply2 = json.loads(body2)
            caught_false2 = st2 == 200 and reply2.get("caught_up") is False
            line = (
                f"  A send #2 (B still behind the NEW post) -> HTTP {st2}: caught_up={reply2.get('caught_up')!r} "
                f"[false until B reads it: {caught_false2}]\n"
            )
            print(line, end="")
            fh.write(line)

            # B drains the follow-up so its cursor reaches A's latest authored entry.
            st_b2, bb2 = get(_k(f"{base}/recv?t={tok_b}&wait=2"), timeout=HTTP_TIMEOUT)
            b_saw2 = st_b2 == 200 and "rollout at noon" in bb2
            line = f"  B recv (reads A's follow-up) -> HTTP {st_b2}: {bb2.strip()[:120]} [saw follow-up: {b_saw2}]\n"
            print(line, end="")
            fh.write(line)

            # A drains its OWN backlog (the join notices + its own two posts are all
            # still unread by A -- recv is the only cursor mover) so A's NEXT recv is
            # genuinely "nothing new" and returns the idle heartbeat rather than a
            # bare backlog array. This moves A's cursor only; it does NOT affect the
            # caught_up predicate, which keys on B's cursor vs A's last authored entry.
            get(_k(f"{base}/recv?t={tok_a}&wait=2"), timeout=HTTP_TIMEOUT)

            # A's idle heartbeat now reports caught_up TRUE (B is current with A's
            # latest). The idle heartbeat shares the EXACT predicate the send reply
            # uses (_caught_up), so this confirms the true branch the send reply will
            # report for any subsequent post once everyone is current. (Asserting it
            # via a fresh send would itself create a new unread entry and read false;
            # the heartbeat reads the state without mutating the log.)
            st3, body3 = get(_k(f"{base}/recv?t={tok_a}&wait=1"), timeout=HTTP_TIMEOUT)
            caught_true = st3 == 200 and '"idle": true' in body3 and '"caught_up": true' in body3
            line = f"  A heartbeat after B caught up -> HTTP {st3}: {body3.strip()[:150]} [caught_up true: {caught_true}]\n"
            print(line, end="")
            fh.write(line)

            passed = caught_false and b_saw and caught_false2 and b_saw2 and caught_true
            verdict = (
                "\nVERDICT: the /send 200 reply carries caught_up -- false while another peer has not read the just-posted "
                "message, and the same predicate flips true once all other current peers have caught up. "
                "PASS -- caught_up rides the send round-trip.\n"
                if passed
                else "\nVERDICT: caught_up on the send reply behaved unexpectedly (see above). FAIL.\n"
            )
            print(verdict)
            fh.write(verdict)

            for t in (tok_a, tok_b):
                with contextlib.suppress(Exception):
                    get(_k(f"{base}/unplug?t={t}"), timeout=2)
        finally:
            stop_relay(proc)
    print(f"[saved] {out_path}")
    return passed


def proof_transcript_persist() -> bool:
    """PROOF 30 (transcript persists on close): at relay close the full ordered log
    is written to the transcript state file `_state_path("transcript", room)`,
    rendered IDENTICALLY to /trace, and SURVIVES the close (it is deliberately NOT
    removed by the cleanup that wipes the pid/port/secret files). We run a short
    exchange, capture /trace WHILE OPEN, then close the room (last peer unplugs).
    After close the transcript file must EXIST and its contents must equal the
    captured /trace PLUS the closed trailer (the close appends the closed line and
    persists, so the saved file == the open /trace + that one '--- closed: ... ---'
    line). We use room mode so the exact transcript path is known. Bounded; no hang."""
    out_path = str(Path(TDIR) / "proof_transcript_persist.txt")
    sd = tempfile.mkdtemp(prefix="wire-transcript-")
    room = "logbook"
    passed = False
    proc: subprocess.Popen[str] | None = None
    with Path(out_path).open("w", buffering=1) as fh:
        try:
            banner(fh, "PROOF 30 - TRANSCRIPT PERSISTS ON CLOSE (== /trace + closed trailer, survives cleanup)")
            proc, base = start_relay(
                "transcript",
                {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120", "RELAY_TOPIC": "ship the logbook"},
                room=room,
                statedir=sd,
            )
            assert base is not None
            if not wait_health(base):
                print("relay did not come up", file=sys.stderr)
                sys.exit(1)

            # The transcript file resolves like the other state files but with a
            # `.transcript` ext and -- crucially -- it is NOT removed on close.
            transcript_path = Path(sd) / f".relay.{room}.transcript"
            line = f"  transcript file before close exists: {transcript_path.exists()} ({transcript_path})\n"
            print(line, end="")
            fh.write(line)

            # A short two-peer exchange so the log has real content to persist.
            tok_a = join_token(base)  # peer-1
            tok_b = join_token(base)  # peer-2
            post(base, tok_a, "kickoff from A")
            post(base, tok_b, "ack from B")
            get(_k(f"{base}/recv?t={tok_a}&wait=1"), timeout=HTTP_TIMEOUT)
            get(_k(f"{base}/recv?t={tok_b}&wait=1"), timeout=HTTP_TIMEOUT)

            # Capture /trace WHILE THE ROOM IS STILL OPEN -- this is the exact render
            # the close path will persist (minus the closed trailer it appends).
            st_trace, trace_open = get(_k(f"{base}/trace"), timeout=HTTP_TIMEOUT)
            trace_ok = st_trace == 200 and "kickoff from A" in trace_open and "ack from B" in trace_open
            line = f"  /trace (open) -> HTTP {st_trace}, {len(trace_open)} bytes [has exchange: {trace_ok}]\n"
            print(line, end="")
            fh.write(line)

            # Close the room: last-peer-out. B then A unplug; when the last peer
            # leaves the close funnel runs, appends the closed line, and persists the
            # transcript under the lock.
            get(_k(f"{base}/unplug?t={tok_b}"), timeout=2)
            get(_k(f"{base}/unplug?t={tok_a}"), timeout=2)  # last peer out -> close
            line = "  both peers unplugged (last peer out -> conversation must close + persist transcript)\n"
            print(line, end="")
            fh.write(line)

            # The process self-exits on last-peer close; wait for it so the persist
            # (done under the lock before the on-close callback) is surely flushed.
            exited = False
            deadline = time.time() + 5
            while time.time() < deadline:
                if proc.poll() is not None:
                    exited = True
                    break
                time.sleep(0.1)
            line = f"  relay process self-exited on close: {'YES' if exited else 'NO'} (exit={proc.poll()})\n"
            print(line, end="")
            fh.write(line)

            # (1) the transcript file must EXIST after close (survives cleanup), even
            #     though the pid/port/secret files are removed by the same close path.
            file_exists = False
            deadline = time.time() + 3
            while time.time() < deadline:
                if transcript_path.exists():
                    file_exists = True
                    break
                time.sleep(0.1)
            saved = transcript_path.read_text(encoding="utf-8") if file_exists else ""
            line = f"  transcript file after close exists: {file_exists} ({len(saved)} bytes)\n"
            print(line, end="")
            fh.write(line)

            # The pid/port/secret trio IS removed by close -- proves the transcript's
            # survival is a deliberate carve-out, not "nothing was cleaned up".
            trio = [Path(sd) / f".relay.{room}.{ext}" for ext in ("pid", "port", "secret")]
            trio_gone = not any(p.exists() for p in trio)
            line = f"  pid/port/secret removed by close (transcript exempt): {trio_gone}\n"
            print(line, end="")
            fh.write(line)

            # (2) contents must equal the captured open /trace PLUS the closed
            #     trailer. The close appends '--- closed: <reason> ---' then renders
            #     through the SAME path as /trace, so the saved file is byte-identical
            #     to the open /trace with exactly that one trailer line added.
            #     trace_open already ends in a newline; the renderer joins on "\n" and
            #     adds a final newline, so saved == trace_open + "--- closed: R ---\n".
            has_trailer = "--- closed:" in saved
            body_matches = file_exists and saved.startswith(trace_open) and has_trailer
            extra = saved[len(trace_open) :] if body_matches else "<no clean prefix match>"
            line = f"  saved == open /trace + closed trailer: {body_matches} (appended tail: {extra.strip()[:80]!r})\n"
            print(line, end="")
            fh.write(line)

            passed = trace_ok and exited and file_exists and trio_gone and body_matches
            verdict = (
                "\nVERDICT: at close the full ordered log was persisted to the transcript state file -- it EXISTS after "
                "close (while pid/port/secret were removed) and its contents equal the open /trace plus the appended "
                "closed trailer, rendered identically to /trace. PASS -- transcript persists on close.\n"
                if passed
                else "\nVERDICT: transcript-persist-on-close behaved unexpectedly (see above). FAIL.\n"
            )
            print(verdict)
            fh.write(verdict)
        finally:
            if proc is not None:
                stop_relay(proc)
            shutil.rmtree(sd, ignore_errors=True)  # scratch statedir; the committed proof_*.txt stays
    print(f"[saved] {out_path}")
    return passed


def _get_with_headers(url: str, headers: dict[str, str], timeout: float = HTTP_TIMEOUT) -> tuple[int, str]:
    """Like get(), but sets request headers on the urllib Request -- used to forge
    the Host / X-Forwarded-Proto a reverse proxy would add, proving the relay
    derives the advertised base from them. urllib honors an explicit Host header
    verbatim (it does not re-derive it from the URL), so this exactly mimics a peer
    arriving through a proxy."""
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, str(e)


def proof_public_base() -> bool:
    """PROOF (public base / reverse-proxy URL): the /jack manual must advertise a
    PUBLIC, reachable base -- not blindly reconstruct http://host:<local-port>.
    Three cases:
      (a) EXPLICIT override (RELAY_PUBLIC_BASE): the manual's recv AND send lines
          use that base verbatim (https, public host), carry NO :<bound-port>, and
          no http://127. base leaks through.
      (b) FORWARDED-HEADER auto-detect (NO override): a /jack arriving with
          Host: x.ngrok-free.app + X-Forwarded-Proto: https renders base
          https://x.ngrok-free.app -- https scheme, public host, no port. This is
          the bug fix: the old code re-appended the LOCAL port and forced http://.
      (c) BACK-COMPAT: a normal /jack (Host 127.0.0.1:<port>, no XFP) still renders
          http://127.0.0.1:<port> exactly as before -- LAN/localhost unchanged.
    Bounded gets throughout -- nothing here can hang."""
    out_path = str(Path(TDIR) / "proof_public_base.txt")

    NGROK = "https://x.ngrok-free.app"
    passed = False
    with Path(out_path).open("w", buffering=1) as fh:
        banner(fh, "PROOF - PUBLIC BASE (reverse-proxy / ngrok URL in the /jack manual)")

        checks: list[tuple[str, bool]] = []  # (label, ok)

        # --- (a) EXPLICIT override via RELAY_PUBLIC_BASE --------------------
        # Launch with the override set; the manual must use it verbatim regardless
        # of the local bound port. (A trailing slash is given to prove it's stripped
        # so "{base}/recv" stays clean -- one slash, never two.)
        proc_a, base_a = start_relay(
            "public_base_env",
            {"RELAY_PUBLIC_BASE": NGROK + "/", "RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120"},
        )
        assert base_a is not None
        bound_port_a = base_a.rsplit(":", 1)[1]  # the LOCAL port; must NOT leak into the manual
        try:
            if not wait_health(base_a):
                print("relay (override) did not come up", file=sys.stderr)
                sys.exit(1)
            st_a, manual_a = get(_k(f"{base_a}/jack"), timeout=HTTP_TIMEOUT)
            recv_a = next((ln for ln in manual_a.splitlines() if "recv:" in ln and "/recv?" in ln), "")
            send_a = next((ln for ln in manual_a.splitlines() if "send:" in ln and "/send?" in ln), "")
            line = (
                f"(a) RELAY_PUBLIC_BASE={NGROK!r} (local bound port {bound_port_a}); /jack -> HTTP {st_a}\n"
                f"      recv: {recv_a.strip()}\n      send: {send_a.strip()}\n"
            )
            print(line, end="")
            fh.write(line)
            checks.append(("(a) recv uses the override base /recv", f"{NGROK}/recv?" in recv_a))
            checks.append(("(a) send uses the override base /send", f"{NGROK}/send?" in send_a))
            # No phantom local port appended to the override base anywhere in the manual.
            checks.append((f"(a) no :{bound_port_a} bound-port in manual", f":{bound_port_a}" not in manual_a))
            checks.append(("(a) no http://127. base leaked", "http://127." not in manual_a))
            # The override is verbatim with exactly one slash before recv/send (slash stripped).
            checks.append(("(a) trailing slash stripped (no //recv)", f"{NGROK}//" not in manual_a))
        finally:
            stop_relay(proc_a)

        # --- (b) FORWARDED-HEADER auto-detect (NO override) ----------------
        # No RELAY_PUBLIC_BASE: the relay must derive the base from the request's
        # Host + X-Forwarded-Proto, exactly as a peer arriving through ngrok sends.
        proc_b, base_b = start_relay("public_base_xfp", {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120"})
        assert base_b is not None
        bound_port_b = base_b.rsplit(":", 1)[1]
        try:
            if not wait_health(base_b):
                print("relay (xfp) did not come up", file=sys.stderr)
                sys.exit(1)
            st_b, manual_b = _get_with_headers(
                _k(f"{base_b}/jack"),
                {"Host": "x.ngrok-free.app", "X-Forwarded-Proto": "https"},
                timeout=HTTP_TIMEOUT,
            )
            recv_b = next((ln for ln in manual_b.splitlines() if "recv:" in ln and "/recv?" in ln), "")
            send_b = next((ln for ln in manual_b.splitlines() if "send:" in ln and "/send?" in ln), "")
            line = (
                f"(b) NO override; request Host: x.ngrok-free.app + X-Forwarded-Proto: https "
                f"(local bound port {bound_port_b}); /jack -> HTTP {st_b}\n"
                f"      recv: {recv_b.strip()}\n      send: {send_b.strip()}\n"
            )
            print(line, end="")
            fh.write(line)
            # Derived base = https://x.ngrok-free.app : https scheme, public host, NO port.
            checks.append(("(b) recv derives https://x.ngrok-free.app", f"{NGROK}/recv?" in recv_b))
            checks.append(("(b) send derives https://x.ngrok-free.app", f"{NGROK}/send?" in send_b))
            checks.append(("(b) https scheme honored (no http://x.ngrok)", "http://x.ngrok-free.app" not in manual_b))
            checks.append((f"(b) no :{bound_port_b} bound-port appended", f":{bound_port_b}" not in manual_b))
        finally:
            stop_relay(proc_b)

        # --- (c) BACK-COMPAT: plain /jack, no override, no XFP -------------
        # The harness's own get() sends Host: 127.0.0.1:<port> and no XFP, exactly
        # like a direct LAN/localhost client -- the base must be byte-identical to
        # today: http://127.0.0.1:<bound-port>.
        proc_c, base_c = start_relay("public_base_plain", {"RELAY_MAX_TURNS": "40", "RELAY_MAX_SECONDS": "120"})
        assert base_c is not None
        bound_port_c = base_c.rsplit(":", 1)[1]
        expect_c = f"http://127.0.0.1:{bound_port_c}"
        try:
            if not wait_health(base_c):
                print("relay (plain) did not come up", file=sys.stderr)
                sys.exit(1)
            st_c, manual_c = get(_k(f"{base_c}/jack"), timeout=HTTP_TIMEOUT)
            recv_c = next((ln for ln in manual_c.splitlines() if "recv:" in ln and "/recv?" in ln), "")
            send_c = next((ln for ln in manual_c.splitlines() if "send:" in ln and "/send?" in ln), "")
            line = (
                f"(c) NO override, no XFP (direct localhost, bound port {bound_port_c}); /jack -> HTTP {st_c}\n"
                f"      recv: {recv_c.strip()}\n      send: {send_c.strip()}\n"
                f"      expected base: {expect_c}\n"
            )
            print(line, end="")
            fh.write(line)
            checks.append(("(c) recv base unchanged http://127.0.0.1:<port>", f"{expect_c}/recv?" in recv_c))
            checks.append(("(c) send base unchanged http://127.0.0.1:<port>", f"{expect_c}/send?" in send_c))
        finally:
            stop_relay(proc_c)

        all_ok = True
        for label, ok in checks:
            all_ok = all_ok and ok
            ln = f"  {label}: {'OK' if ok else 'FAIL'}\n"
            print(ln, end="")
            fh.write(ln)

        passed = all_ok
        verdict = (
            "\nVERDICT: the /jack manual advertises a correct PUBLIC base -- a RELAY_PUBLIC_BASE override is used "
            "verbatim, a forwarded Host + X-Forwarded-Proto auto-derives https://host with no phantom port, and a "
            "plain localhost jack is byte-identical to before. PASS -- works behind ngrok / a TLS proxy.\n"
            if passed
            else "\nVERDICT: advertised base behaved unexpectedly (see FAILs above). FAIL.\n"
        )
        print(verdict)
        fh.write(verdict)
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
        if which in ("all", "bodycap"):
            results["body_cap"] = proof_body_cap()
        if which in ("all", "sendrate"):
            results["send_rate"] = proof_send_rate()
        if which in ("all", "presence"):
            results["presence"] = proof_presence()
        if which in ("all", "lastpeer"):
            results["last_peer_closes"] = proof_last_peer_closes()
        if which in ("all", "reap"):
            results["peer_reap"] = proof_peer_reap()
        if which in ("all", "sigterm"):
            results["sigterm_cleanup"] = proof_sigterm_cleanup()
        if which in ("all", "brief"):
            results["brief"] = proof_brief()
        if which in ("all", "gate"):
            results["gate"] = proof_gate()
        if which in ("all", "role"):
            results["role_surfaces"] = proof_role_surfaces()
        if which in ("all", "envrt"):
            results["envelope_roundtrip"] = proof_envelope_roundtrip()
        if which in ("all", "envbc"):
            results["envelope_backcompat"] = proof_envelope_backcompat()
        if which in ("all", "mine"):
            results["recv_mine_filter"] = proof_recv_mine_filter()
        if which in ("all", "rooms"):
            results["rooms_isolation"] = proof_rooms_isolation()
        if which in ("all", "rooms", "lock"):
            results["room_lock"] = proof_room_lock()
        if which in ("all", "rooms", "stale"):
            results["room_stale_reclaim"] = proof_room_stale_reclaim()
        if which in ("all", "since"):
            results["since"] = proof_since()
        if which in ("all", "replaywin"):
            results["replay_window"] = proof_replay_window()
        if which in ("all", "floor"):
            results["floor_grant_and_queue"] = proof_floor_grant_and_queue()
        if which in ("all", "floor", "floorlease"):
            results["floor_lease_expiry"] = proof_floor_lease_expiry()
        if which in ("all", "floor", "flooradv"):
            results["floor_advisory_nonblocking"] = proof_floor_advisory_nonblocking()
        if which in ("all", "floor", "floorreap"):
            results["floor_holder_reaped"] = proof_floor_holder_reaped()
        if which in ("all", "exclude_me"):
            results["exclude_me"] = proof_exclude_me()
        if which in ("all", "caught_up_send"):
            results["caught_up_send"] = proof_caught_up_send()
        if which in ("all", "transcript_persist"):
            results["transcript_persist"] = proof_transcript_persist()
        if which in ("all", "public_base"):
            results["public_base"] = proof_public_base()
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
