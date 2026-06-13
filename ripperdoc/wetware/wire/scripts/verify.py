#!/usr/bin/env python3
"""
verify.py - end-to-end localhost proof for the wire bus.

Spins up bus.py on a private test port, runs fake agents against it EXACTLY as a
real agent would (join -> parse manual -> recv/send loop -> leave), and captures
transcripts to ./transcripts/. There are NO rooms: one bus process == one
conversation, and the process EXITS when the conversation closes. So each
scenario gets its OWN bus process on its OWN port.

  PROOF 1 (group exchange): 3 agents cooperatively count to a target; the agent
           that reaches it announces done and leaves; the others see the
           departure and leave too. When the last peer leaves the broker closes
           and the process exits. Proves group fanout, long-poll wake, a clean
           leave/close cascade, and process-exit-on-empty.

  PROOF 2 (safety): agents that never stop, with the turn cap set low (6). The
           broker must force-close (and exit). A second variant proves the
           repetition-kill; a third proves parked /recv release on close.

Run:  python3 verify.py
Pure stdlib. Starts/stops its own brokers; leaves no pids or stray processes.
"""

import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
BUS = os.path.join(HERE, "bus.py")
AGENT = os.path.join(HERE, "fake_agent.py")
TDIR = os.path.join(os.path.dirname(HERE), "transcripts")  # wire/transcripts/

# ---------------------------------------------------------------------------
# Timeouts + a hard wall-clock WATCHDOG. The whole point of this proof is that
# it can NEVER hang: a regression in the broker's close path once wedged the
# safety run for ~18 minutes on zombie long-polls. So:
#   * every HTTP call here uses a SHORT timeout (HTTP_TIMEOUT),
#   * every child process is registered and waited on with a SHORT timeout,
#   * a daemon watchdog kills the broker + ALL children and force-exits with
#     PARTIAL/TIMEOUT if the whole run exceeds WATCHDOG_SECONDS.
# There is no unbounded wait anywhere in this file or the fake agents' paths.
# ---------------------------------------------------------------------------
HTTP_TIMEOUT = 5  # seconds, every urllib call in the test path
AGENT_WAIT = 20  # seconds, max we wait on any single agent process
WATCHDOG_SECONDS = 90  # hard ceiling on the ENTIRE verify run

# Every Popen we create is tracked here so the watchdog can reap them all.
_PROCS = []
_PROCS_LOCK = threading.Lock()


def _register(proc):
    with _PROCS_LOCK:
        _PROCS.append(proc)
    return proc


def _kill_all():
    """Terminate, then hard-kill, every process we ever started."""
    with _PROCS_LOCK:
        procs = list(_PROCS)
    for p in procs:
        try:
            if p.poll() is None:
                p.terminate()
        except Exception:  # noqa: BLE001
            pass
    deadline = time.time() + 3
    for p in procs:
        try:
            p.wait(timeout=max(0.0, deadline - time.time()))
        except Exception:  # noqa: BLE001
            try:
                p.kill()
            except Exception:  # noqa: BLE001
                pass


def _start_watchdog():
    """Daemon thread: if the run overruns, reap everything and exit nonzero.

    Uses os._exit so a child stuck in a C-level read can't keep us alive."""

    def _bark():
        time.sleep(WATCHDOG_SECONDS)
        sys.stderr.write(
            f"\nPARTIAL/TIMEOUT: verify exceeded {WATCHDOG_SECONDS}s wall clock "
            f"-- killing broker + all child procs and aborting.\n"
        )
        sys.stderr.flush()
        _kill_all()
        os._exit(124)  # 124 == conventional "timed out"

    t = threading.Thread(target=_bark, name="verify-watchdog", daemon=True)
    t.start()
    return t


def get(url, timeout=HTTP_TIMEOUT):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return 0, str(e)


def wait_health(base, tries=50):
    for _ in range(tries):
        status, _ = get(base + "/health", timeout=1)
        if status == 200:
            return True
        time.sleep(0.1)
    return False


def start_broker(tag, env_overrides):
    """Start a test broker bound to an OS-assigned FREE port (BUS_PORT=0). We
    read the actually-bound port back from the broker's own portfile, so the
    auto-scan bind logic stays deterministic in the harness -- no fixed port can
    collide, and we never depend on a guess. Returns (proc, base_url).

    `tag` only names the per-broker pid/port files in tmp so concurrent test
    brokers never clobber the real plugin files (wire/.bus.pid / .bus.port) or
    each other."""
    portfile = os.path.join(tempfile.gettempdir(), f"wire-verify-{tag}.port")
    try:
        os.remove(portfile)  # stale file from a prior run would mislead the readback
    except OSError:
        pass
    env = dict(os.environ)
    env["BUS_HOST"] = "127.0.0.1"
    env["BUS_PORT"] = "0"  # OS picks a free port; we read it back from the portfile
    # Per-broker pid/port files in a temp dir so concurrent test brokers never
    # clobber the real plugin files (wire/.bus.pid / .bus.port) or each other.
    env["BUS_PIDFILE"] = os.path.join(tempfile.gettempdir(), f"wire-verify-{tag}.pid")
    env["BUS_PORTFILE"] = portfile
    env.update(env_overrides)
    # Capture broker stdout so we can show join/leave/close log lines if needed.
    proc = subprocess.Popen(
        [sys.executable, BUS],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    _register(proc)
    # Read the bound port back from the portfile (bounded wait -- never block).
    port = None
    for _ in range(50):  # ~5s max
        try:
            with open(portfile) as f:
                txt = f.read().strip()
            if txt:
                port = int(txt)
                break
        except (OSError, ValueError):
            pass
        time.sleep(0.1)
    if port is None:
        raise RuntimeError(f"broker [{tag}] never wrote its portfile {portfile}")
    return proc, f"http://127.0.0.1:{port}"


def stop_broker(proc):
    """Stop a broker. It may have ALREADY self-exited (close -> process exit);
    that's expected and fine -- terminate() on a dead proc is a no-op."""
    if proc.poll() is None:
        proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


def run_agents(specs, base):
    """Launch agents (list of arg lists), capture each one's stdout, wait.

    Each agent is waited on with a SHORT per-process timeout (AGENT_WAIT). If
    an agent does not exit in time it is killed and its output is tagged
    <<KILLED: did not exit>> -- so one stuck agent can never wedge the run.
    (The global watchdog is the ultimate backstop above this.)"""
    procs = []
    for spec in specs:
        p = subprocess.Popen(
            [sys.executable, AGENT, "--base", base, *spec],
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
            out += f"{AGENT_WAIT}s -- broker close path may have hung a recv>>\n"
        outs.append(out)
    return outs


def banner(fh, title):
    line = "=" * 72
    print(line)
    print(title)
    print(line)
    fh.write(line + "\n" + title + "\n" + line + "\n")


def join_token(base, timeout=HTTP_TIMEOUT):
    """Join and scrape the token out of the manual, exactly like an agent.
    Returns the opaque token (or raises)."""
    status, manual = get(f"{base}/join", timeout=timeout)
    m = re.search(r"/recv\?t=([0-9a-f]+)", manual)
    if not m:
        raise RuntimeError(f"join failed ({status}): {manual[:120]}")
    return m.group(1)


def show_manual(fh, topic):
    """Spin up a THROWAWAY bus on its own port purely to capture the /join
    manual verbatim, then stop it. Doing this against the REAL conversation's
    bus would mint a peer and -- because one bus is one conversation -- a later
    leave/empty would close it; a separate process keeps the real run pristine."""
    proc, base = start_broker("manual", {"BUS_TOPIC": topic, "BUS_MAX_TURNS": "40", "BUS_MAX_SECONDS": "120"})
    try:
        if not wait_health(base):
            return
        status, manual = get(f"{base}/join", timeout=5)
        banner(fh, f"/join MANUAL (verbatim, status {status})")
        print(manual)
        fh.write(manual + "\n")
    finally:
        stop_broker(proc)


def park_recv(base, token, results, idx):
    """Park ONE long-poll /recv (asking for the full 600s wait) and record how
    long it actually blocked before returning. Used to PROVE the deadlock fix:
    when the conversation closes, this must return within a moment -- NOT sit
    for the full 600s. The urllib timeout is short (HTTP_TIMEOUT+1) so even a
    true regression frees this thread quickly and shows up as a ~6s elapsed,
    never an 18-minute hang."""
    t0 = time.time()
    status, body = get(f"{base}/recv?t={token}&wait=600", timeout=HTTP_TIMEOUT + 1)
    results[idx] = {
        "elapsed": round(time.time() - t0, 3),
        "status": status,
        "body": body.strip()[:160],
    }


def proof_group():
    out_path = os.path.join(TDIR, "proof_group.txt")
    fh = open(out_path, "w", buffering=1)  # line-buffered: flush as we go

    # Generous caps so the natural leave/close -- not a cap -- ends this run.
    proc, base = start_broker("group", {"BUS_MAX_TURNS": "40", "BUS_MAX_SECONDS": "120"})
    try:
        if not wait_health(base):
            print("broker did not come up", file=sys.stderr)
            sys.exit(1)

        banner(fh, "PROOF 1 - GROUP EXCHANGE (3 agents, shared log, clean leave/close)")

        # Show the /join manual verbatim (the UX centerpiece) from a SEPARATE
        # throwaway bus, so previewing it can't perturb the real conversation
        # (a join + leave on it would close it and exit its process).
        show_manual(fh, topic="ship the release")

        # Now run THREE real-style agents counting to 6 against the real bus. One
        # is told to open the discussion (--kickoff); the others react. Target
        # small so the exchange is short and readable.
        print("\n--- launching 3 agents (collab, target=6) ---\n")
        fh.write("\n--- launching 3 agents (collab, target=6) ---\n\n")
        # Two responders launch first and park on recv; the kickoff agent
        # launches LAST and posts the opening 'count: 1'. (Cursors now start at
        # the log's START so a joiner gets the full backlog on its first recv --
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

        # The last agent's leave empties the conversation -> broker closes and
        # the process exits (after a short grace). Try to grab /history while
        # it's still up; if the process already exited, the per-agent stdout
        # above is the authoritative record. Either way we never block.
        status, tx = get(f"{base}/history", timeout=2)
        banner(fh, "BROKER HISTORY (human watcher view)")
        if status == 200:
            print(tx)
            fh.write(tx + "\n")
        else:
            note = "(broker already exited on empty-conversation close -- see agent stdout above)\n"
            print(note)
            fh.write(note)

        # Confirm the process self-exited on close (the lifecycle==process rule).
        time.sleep(0.6)
        exited = proc.poll() is not None
        verdict = f"\nbroker process self-exited on close: {'YES' if exited else 'NO'} (exit={proc.poll()})\n"
        print(verdict)
        fh.write(verdict)
    finally:
        stop_broker(proc)
        fh.close()
    print(f"[saved] {out_path}")
    return out_path


def proof_safety():
    out_path = os.path.join(TDIR, "proof_safety.txt")
    fh = open(out_path, "w", buffering=1)  # line-buffered: flush as we go

    # --- 2a: turn cap force-close -------------------------------------
    proc, base = start_broker("turncap", {"BUS_MAX_TURNS": "6", "BUS_MAX_SECONDS": "120"})
    try:
        if not wait_health(base):
            print("broker did not come up", file=sys.stderr)
            sys.exit(1)
        banner(fh, "PROOF 2a - TURN CAP (BUS_MAX_TURNS=6): broker force-closes runaway agents")
        print("\n--- launching 3 spammer agents that never stop (distinct lines) ---\n")
        fh.write("\n--- launching 3 spammer agents that never stop (distinct lines) ---\n\n")
        specs = [["--mode", "spammer", "--max-turns", "6"] for _ in range(3)]
        outs = run_agents(specs, base)
        for i, out in enumerate(outs, 1):
            header = f"\n----- spammer process #{i} stdout -----"
            print(header)
            print(out)
            fh.write(header + "\n" + out)
        # Broker has closed + exited on the cap. Grab history if still up.
        status, tx = get(f"{base}/history", timeout=2)
        banner(fh, "BROKER HISTORY (note the forced close at 6 posts)")
        if status == 200:
            print(tx)
            fh.write(tx + "\n")
        else:
            note = "(broker already exited on turn-cap close -- see agent stdout above)\n"
            print(note)
            fh.write(note)
    finally:
        stop_broker(proc)

    # --- 2b: repetition kill ------------------------------------------
    # High turn cap so ONLY the repetition rule can close it.
    proc, base = start_broker("repeat", {"BUS_MAX_TURNS": "40", "BUS_REPEAT_WINDOW": "3"})
    try:
        if not wait_health(base):
            print("broker did not come up", file=sys.stderr)
            sys.exit(1)
        banner(fh, "PROOF 2b - REPETITION KILL (BUS_REPEAT_WINDOW=3): identical posts close it")
        print("\n--- launching 2 spammer agents posting the IDENTICAL line ---\n")
        fh.write("\n--- launching 2 spammer agents posting the IDENTICAL line ---\n\n")
        specs = [["--mode", "spammer", "--same", "--max-turns", "40"] for _ in range(2)]
        outs = run_agents(specs, base)
        for i, out in enumerate(outs, 1):
            header = f"\n----- spammer process #{i} stdout -----"
            print(header)
            print(out)
            fh.write(header + "\n" + out)
        status, tx = get(f"{base}/history", timeout=2)
        banner(fh, "BROKER HISTORY (note the 'stalled/repetition' close)")
        if status == 200:
            print(tx)
            fh.write(tx + "\n")
        else:
            note = "(broker already exited on repetition-kill close -- see agent stdout above)\n"
            print(note)
            fh.write(note)
    finally:
        stop_broker(proc)

    # --- 2c: parked recv release on close (THE deadlock fix) ----------
    # This is the regression that wedged the safety run for ~18 minutes: when the
    # conversation closes, every /recv already parked on a long-poll must be
    # released IMMEDIATELY -- it must not block until its own 600s wait expires.
    # Here we park three long-poll recvs (each asking for the full 600s), let
    # them settle, then trip the turn cap from a separate writer and measure how
    # long each parked recv actually blocked. They must all return in well under
    # a second carrying the closure signal.
    proc, base = start_broker("parked", {"BUS_MAX_TURNS": "1", "BUS_MAX_SECONDS": "120"})
    try:
        if not wait_health(base):
            print("broker did not come up", file=sys.stderr)
            sys.exit(1)
        banner(fh, "PROOF 2c - PARKED-RECV RELEASE ON CLOSE (the deadlock fix)")
        msg = (
            "Parking 3 long-poll recvs (each requesting the full wait=600s), "
            "then a 4th peer trips the turn cap (BUS_MAX_TURNS=1).\n"
            "Each parked recv MUST return within a moment of close -- not sit "
            "for 600s. Elapsed times below are the proof.\n"
        )
        print(msg)
        fh.write(msg + "\n")

        parkers = [join_token(base) for _ in range(3)]
        writer = join_token(base)
        results = {}
        threads = [threading.Thread(target=park_recv, args=(base, tok, results, i)) for i, tok in enumerate(parkers)]
        for t in threads:
            t.start()
        time.sleep(0.5)  # ensure all three are genuinely parked on cond.wait

        # POST the cap-tripping message (a tiny urllib POST). This is the
        # "close moment" -- the parked recvs above must be released right after.
        req = urllib.request.Request(f"{base}/send?t={writer}", data=b"go", method="POST")
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
            ln = f"  parked recv #{i + 1}: released after {r['elapsed']}s (status {r['status']}) <- {r['body']}\n"
            print(ln, end="")
            fh.write(ln)

        verdict = f"\nVERDICT: worst parked-recv wake = {worst}s after close. " + (
            "PASS -- no recv outlived close by more than a moment.\n"
            if 0 <= worst < 2.0
            else "FAIL -- a parked recv blocked too long (deadlock not fixed).\n"
        )
        print(verdict)
        fh.write(verdict)

        status, tx = get(f"{base}/history", timeout=2)
        banner(fh, "BROKER HISTORY (deadlock-check)")
        if status == 200:
            print(tx)
            fh.write(tx + "\n")
        else:
            note = "(broker already exited on close -- expected)\n"
            print(note)
            fh.write(note)
    finally:
        stop_broker(proc)
        fh.close()
    print(f"[saved] {out_path}")
    return out_path


def post(base, token, body, timeout=HTTP_TIMEOUT):
    """Raw POST to /send (a real agent would curl this). Returns (status, text)."""
    req = urllib.request.Request(f"{base}/send?t={token}", data=body.encode("utf-8"), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return 0, str(e)


def proof_backlog():
    """PROOF 3 (backlog-on-join): peer A joins and posts 'hello' BEFORE peer B
    exists. Then B joins and its FIRST recv must return that 'hello' -- the
    backlog -- immediately, NOT block/timeout. This is the host-says-hi-then-
    hands-over-the-join-URL case: a late joiner has to catch up on its first
    read. We use a SHORT bounded wait (wait=2) so even a regression (cursor
    starting at the log's end -> nothing to return) surfaces as a quick 204,
    never a hang."""
    out_path = os.path.join(TDIR, "proof_backlog.txt")
    fh = open(out_path, "w", buffering=1)

    # Generous caps so A's single 'hello' can't trip a close before B reads it.
    proc, base = start_broker("backlog", {"BUS_MAX_TURNS": "40", "BUS_MAX_SECONDS": "120"})
    passed = False
    try:
        if not wait_health(base):
            print("broker did not come up", file=sys.stderr)
            sys.exit(1)
        banner(fh, "PROOF 3 - BACKLOG ON JOIN (late joiner's first recv returns the pre-join log)")

        # Peer A joins and speaks FIRST, before B is anywhere.
        tok_a = join_token(base)
        line = "peer A joined and posts 'hello, lets discuss X' (before B exists)\n"
        print(line)
        fh.write(line)
        st, _ = post(base, tok_a, "hello, lets discuss X")
        line = f"  A send -> HTTP {st}\n"
        print(line, end="")
        fh.write(line)

        # NOW peer B joins -- strictly after A's post is already on the log.
        tok_b = join_token(base)
        line = "peer B joined AFTER A's post; B runs its FIRST recv (wait=2, bounded)\n"
        print(line)
        fh.write(line)

        # B's first recv must hand back the backlog (A's 'hello') right away.
        status, body = get(f"{base}/recv?t={tok_b}&wait=2", timeout=HTTP_TIMEOUT)
        line = f"  B first recv -> HTTP {status}: {body.strip()[:160]}\n"
        print(line, end="")
        fh.write(line)

        saw_hello = status == 200 and "hello, lets discuss X" in body
        passed = saw_hello
        verdict = (
            "\nVERDICT: B's first recv returned A's pre-join 'hello'. PASS -- backlog delivered on join.\n"
            if saw_hello
            else f"\nVERDICT: B's first recv did NOT carry the backlog (status {status}). "
            "FAIL -- late joiner missed pre-join messages.\n"
        )
        print(verdict)
        fh.write(verdict)

        # Sanity: B's SECOND recv (bounded, nothing new) should now 204 -- the
        # cursor advanced past the backlog, so it doesn't re-deliver 'hello'.
        status2, body2 = get(f"{base}/recv?t={tok_b}&wait=1", timeout=HTTP_TIMEOUT)
        line = f"  B second recv (should be 204, no re-delivery) -> HTTP {status2}\n"
        print(line, end="")
        fh.write(line)

        # Leave cleanly so the broker closes and self-exits (no stray process).
        get(f"{base}/leave?t={tok_a}", timeout=2)
        get(f"{base}/leave?t={tok_b}", timeout=2)
    finally:
        stop_broker(proc)
        fh.close()
    print(f"[saved] {out_path}")
    return passed


if __name__ == "__main__":
    os.makedirs(TDIR, exist_ok=True)
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    _start_watchdog()  # hard ceiling: nothing here can hang past WATCHDOG_SECONDS
    t0 = time.time()
    try:
        if which in ("all", "group"):
            proof_group()
        if which in ("all", "backlog"):
            proof_backlog()
        if which in ("all", "safety"):
            proof_safety()
        print(f"\nverification complete in {time.time() - t0:.1f}s.")
    finally:
        # Belt-and-suspenders: reap anything still alive so we never leave a
        # stray broker or agent behind, even on an exception.
        _kill_all()
