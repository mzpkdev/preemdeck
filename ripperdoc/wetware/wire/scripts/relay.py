#!/usr/bin/env python3
"""
relay.py - a zero-dependency HTTP "wire" relay for live multi-agent group chat.

WHAT THIS IS
------------
One host runs this single file. ONE process == ONE conversation. Multiple LLM
coding agents on the LAN talk to it with plain `curl` to hold a live GROUP
conversation. Within one conversation there are no sub-rooms: the host:port IS
that conversation's identity. The relay is self-describing: an agent's first
call (`GET /jack`) returns a plain-text MANUAL telling it exactly how to
participate -- with the curl commands already filled in, token and all.

PER-SESSION ROOMS (one relay per Claude session on a host)
----------------------------------------------------------
So that several Claude sessions on ONE host can each run their own relay without
clobbering each other, the relay's three state files are NAMESPACED by a "room"
id when one is supplied. Pass --room <id> (or the RELAY_ROOM env): the state
files become `.relay.<id>.{pid,port,secret}` instead of the bare
`.relay.{pid,port,secret}`. The /uplink + /eject skills derive that id from the
Claude session (CLAUDE_CODE_SESSION_ID, first 8 chars), so uplink and eject in
the SAME session land on the SAME files and eject kills exactly its own relay.
No --room/RELAY_ROOM (e.g. cron, a bare shell) -> the bare un-namespaced files,
i.e. the original single-room behavior. RELAY_STATEDIR overrides the directory
those files live in (default: the plugin dir). The pidfile doubles as a
per-room startup LOCK (O_EXCL): a second relay for the SAME room+dir refuses to
start rather than racing onto another port.

Runs on the Python 3 standard library alone. No pip, ever:

    python3 relay.py                  # binds 0.0.0.0:55555 (scans up if busy)
    python3 relay.py 0.0.0.0 9000     # host + port via argv
    RELAY_HOST=127.0.0.1 RELAY_PORT=9000 python3 relay.py   # or via env
    python3 relay.py 0.0.0.0 9000 --brief "what we're discussing"   # seed a topic brief
    python3 relay.py 0.0.0.0 9000 --secret "shared-key"   # gate access with a shared secret
    python3 relay.py 0.0.0.0 9000 --room ff49f4c0   # namespace state files for this session
    RELAY_ROOM=ff49f4c0 RELAY_STATEDIR=/tmp/x python3 relay.py   # room + state dir via env

SOFT GATE (shared secret)
-------------------------
The relay binds 0.0.0.0 on the LAN, so a shared secret gates access. Pass it
with --secret "<value>" (or the RELAY_SECRET env); if neither is given the relay
self-generates one (secrets.token_hex(16)) and prints it. The secret is written
to .relay.secret next to the pid/port files and removed on clean close. Gated
routes require a correct ?k=<secret> query param, compared in constant time
(hmac.compare_digest); a missing/wrong key gets HTTP 401. /jack /recv /send
/unplug /trace /peers are gated; /health stays OPEN (the uplink double-start
guard and the eject down-check probe it without knowing the secret). The key
check is INDEPENDENT of the per-peer token: /recv needs BOTH ?t= (token) and
?k= (secret); /trace and /jack need ?k= only -- which is what closes the old
/trace-reads-everything hole. THIS IS A SOFT GATE: it is plain HTTP and the key
rides in cleartext, so it keeps strangers out, NOT a network sniffer. For real
protection put it behind TLS or bind localhost + an SSH/tunnel.

TOPIC BRIEF
-----------
--brief "<string>" (or RELAY_BRIEF env) seeds the conversation with a topic up
front. The brief becomes the FIRST log entry (seq 1, authored "system"), so it
tops every joiner's first /recv backlog and shows in /trace; it is also rendered
as a TOPIC block in the /jack manual, since a remote peer reads the manual
BEFORE its first /recv. The string may be multiline; it survives intact through
argv -> log entry -> /recv JSON -> manual. No --brief == freeform room (no seq-1
entry, no TOPIC block), exactly as before. The relay stays a dumb broker: it
never paraphrases the brief -- the wording is whatever the launcher passed.

CORE MODEL
----------
* The conversation is ONE shared append-only message log, kept in RAM. It is
  group chat: everyone reads the same log, and any post is visible to all.
* Identity is NOT human-chosen. On jack the relay mints an opaque hidden
  *token* (6 hex chars) and a short display *handle* ("peer-1"). The token is
  the agent's credential AND it keys a server-side read *cursor*. Agents never
  pass names or cursor numbers -- the server tracks each token's cursor.

LIFECYCLE == PROCESS
--------------------
Agents are assumed to misbehave: they may yap forever, loop, or refuse to stop.
So the relay -- not the agents -- owns the conversation lifecycle and
force-closes when a cap trips (turn cap, wall-clock cap, repetition stall) or
when the last peer leaves. On close the relay releases every parked /recv with
the explicit closed signal, then THE PROCESS EXITS CLEANLY. There is no reuse:
need another conversation, run `uplink` again.

ENDPOINTS  (all but /health require ?k=<secret>)
---------
  GET  /jack?k=<secret>                   -> mint token+handle, return MANUAL (text)
  GET  /recv?t=<token>&k=<secret>&wait=<s> -> LONG-POLL for new messages (JSON; 200 idle heartbeat when quiet)
  POST /send?t=<token>&k=<secret>         -> append a message to the shared log
  GET  /unplug?t=<token>&k=<secret>&reason=... -> this peer leaves (others continue)
  GET  /trace?k=<secret>                  -> full ordered log as plain text
  GET  /peers?k=<secret>                  -> who's currently connected (JSON)
  GET  /health                            -> "ok"   (OPEN -- no key)

STATE FILES + ROOM NAMESPACING
  --room <id> / RELAY_ROOM   -> infix the state files: .relay.<id>.{pid,port,secret}
  RELAY_STATEDIR             -> dir the state files live in (default: plugin dir)
  RELAY_PIDFILE/PORTFILE/SECRETFILE -> per-file overrides; win over the above
  precedence per file: explicit RELAY_*FILE > RELAY_STATEDIR+infix > plugindir+infix
"""

import atexit
import contextlib
import errno
import hmac
import json
import os
import secrets
import signal
import sys
import threading
import time
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

# ---------------------------------------------------------------------------
# Configuration. Everything is overridable via env (and host/port via argv too)
# so the host can tune safety caps without editing code.
# ---------------------------------------------------------------------------
HOST = os.environ.get("RELAY_HOST", "0.0.0.0")
# Default port lives high in the IANA dynamic range (49152-65535) to stay clear
# of common dev ports. It is the BASE: if it's taken we scan upward (see
# _bind_scanning) for the first free port. Override via RELAY_PORT/argv to change
# the base -- we still scan up from there if it's busy.
PORT = int(os.environ.get("RELAY_PORT", "55555"))

# How many consecutive ports to try (base, base+1, ... base+PORT_SCAN-1) before
# giving up when the base is busy.
PORT_SCAN = 50

# Lifecycle caps -- relay-enforced, agents cannot opt out.
MAX_TURNS = int(os.environ.get("RELAY_MAX_TURNS", "40"))  # total accepted posts
MAX_SECONDS = int(os.environ.get("RELAY_MAX_SECONDS", "1800"))  # wall clock from 1st post
REPEAT_WINDOW = int(os.environ.get("RELAY_REPEAT_WINDOW", "3"))  # N consecutive near-dupes -> stall

# Long-poll bounds. A client may ask for a shorter wait; we clamp to the cap.
DEFAULT_WAIT = int(os.environ.get("RELAY_DEFAULT_WAIT", "600"))  # default /recv block (s)
MAX_WAIT = int(os.environ.get("RELAY_MAX_WAIT", "600"))  # hard cap on /recv block (s)

# The server's OWN idle ceiling for a /recv long-poll: how long the relay parks a
# quiet /recv before answering with a 200 idle heartbeat (NOT a 204, NOT a dropped
# socket). This MUST stay comfortably BELOW the client's curl --max-time so a
# healthy-but-quiet relay always wins the race and never looks like a dead
# connection (curl exit 28). Env-tunable like the other RELAY_* knobs; the verify
# harness sets it to ~1-2s so idle proofs run fast. Clamped to a sane upper cap so
# a fat env value can't push it past what a client would wait for.
IDLE_WAIT = min(int(os.environ.get("RELAY_IDLE_WAIT", "25")), 120)  # server idle ceiling (s)

# --- State files: dir + per-room infix -------------------------------------
# The three state files (pid/port/secret) live next to the plugin (wire/), not in
# scripts/. PLUGIN_DIR is the default directory; RELAY_STATEDIR overrides it (the
# verify harness points it at a tmp dir so room derivation runs in isolation).
PLUGIN_DIR = str(Path(__file__).resolve().parent.parent)
STATEDIR = os.environ.get("RELAY_STATEDIR", PLUGIN_DIR)

# A "room" namespaces the state files so several Claude sessions on ONE host each
# get their own relay without clobbering each other. Resolved fully in main()
# (argv --room > RELAY_ROOM env > none); the env read here just gives the globals
# a value if the module is imported, or run, without main() recomputing them.
ROOM = os.environ.get("RELAY_ROOM", "") or None


def _state_path(ext: str, room: str | None) -> str:
    """Default path for a state file of extension `ext` (pid/port/secret). When a
    room is set the filename gains a `.<room>` infix -> `.relay.<room>.<ext>`;
    without a room it's the bare `.relay.<ext>`. The directory is RELAY_STATEDIR
    (default: the plugin dir). This is the MIDDLE precedence tier -- an explicit
    per-file RELAY_*FILE override (resolved in _resolve_statefiles) wins over it."""
    infix = f".{room}" if room else ""
    return str(Path(STATEDIR) / f".relay{infix}.{ext}")


def _resolve_statefiles(room: str | None) -> tuple[str, str, str]:
    """Resolve the (pidfile, portfile, secretfile) paths for `room`. Precedence
    per file: explicit RELAY_PIDFILE/PORTFILE/SECRETFILE env > RELAY_STATEDIR+infix
    > plugin-dir+infix (the last two via _state_path, which reads STATEDIR). The
    per-file overrides still win so anything already relying on them keeps working
    (notably the verify harness's older proofs)."""
    pid = os.environ.get("RELAY_PIDFILE", _state_path("pid", room))
    port = os.environ.get("RELAY_PORTFILE", _state_path("port", room))
    secret = os.environ.get("RELAY_SECRETFILE", _state_path("secret", room))
    return pid, port, secret


# Pidfile so `eject` (and a re-run of `uplink`) can find and kill this process; it
# ALSO doubles as a per-room startup lock (claimed O_EXCL in main()). Portfile
# records the port we ACTUALLY bound (the scan may pick higher than the base) so
# `uplink` can health-check it and `eject` can confirm the relay is down.
# Secretfile records the soft-gate secret so `uplink` can bake ?k=<secret> into
# the host's curls + hand-off line; it is a CREDENTIAL (gitignored, written 0600).
# All three are removed on a clean exit. main() recomputes these (with the
# resolved --room) before any write, so these import-time values just seed them.
PIDFILE, PORTFILE, SECRETFILE = _resolve_statefiles(ROOM)

# The shared secret gating every route except /health. Resolved fully in main()
# (argv --secret > RELAY_SECRET env > self-generated token_hex(16)); the env seed
# here just gives it a value if the module is imported without main() running.
SECRET = os.environ.get("RELAY_SECRET", "")


def _norm(body: str) -> str:
    """Normalize a body for repetition comparison: lowercase + collapse all
    runs of whitespace. Two messages differing only in case/spacing are dupes."""
    return " ".join(body.lower().split())


# ===========================================================================
# Conversation: the ONE shared append-only log + the peers attached to it.
# There is exactly one of these per process. No rooms, no registry.
# ===========================================================================
class Conversation:
    """All mutable state for THE conversation, guarded by one lock.

    The log is the single source of truth. Each entry is a dict:
        {"seq": int, "handle": str, "body": str, "ts": float, "sys": bool}
    `seq` is 1-based and strictly increasing; it doubles as the cursor value.

    A peer is keyed by its opaque token:
        peers[token] = {"handle": str, "cursor": int}
    `cursor` is the seq of the last message this peer has already received. A
    long-polling /recv returns every log entry with seq > cursor, then sets
    cursor to the last seq returned. That is the entire "read position" model;
    agents never see or send a cursor.

    On close, `closed` flips true and the one-shot _on_close callback fires: it
    releases every parked /recv with the closed signal, then asks the server to
    exit. One conversation per process.
    """

    def __init__(self, topic: str = "", brief: str = ""):
        self.topic = topic
        # The topic brief (may be multiline). When set, it is seeded below as the
        # FIRST log entry (seq 1, authored "system") so it tops every joiner's
        # first /recv backlog and /trace; build_manual() also reads it for the
        # TOPIC block. Stored stripped of trailing newlines only -- the body is
        # preserved verbatim (embedded newlines intact). "" == no brief.
        self.brief = brief.rstrip("\n") if brief else ""
        self.lock = threading.Lock()
        # The Condition shares the lock so a parked /recv is woken atomically
        # when /send appends or when we close -- no busy-spin.
        self.cond = threading.Condition(self.lock)

        self.log: list[dict] = []  # ordered, append-only message log
        self.peers: dict[str, dict] = {}  # token -> {"handle", "cursor"}
        self._handle_n = 0  # monotonic counter for "peer-N" handles
        self._any_joined = False  # has at least one peer ever joined?

        self.turns = 0  # count of accepted non-system posts
        self.started_at: float | None = None  # set on first accepted post
        self.closed = False
        self.close_reason: str | None = None
        self.recent_norm: list[str] = []  # normalized recent bodies (repeat kill)

        # Set by main(); called once after close to terminate the process.
        self._on_close: Callable[[str], None] | None = None  # invoked outside the lock

        # Seed the topic brief as the FIRST log entry, authored "system" -- the
        # same envelope as the close/leave notices, just emitted at construction
        # (before the server binds, before any peer can /jack). Because a fresh
        # peer's cursor starts at 0, this seq-1 entry is delivered at the TOP of
        # its very first /recv backlog automatically; /trace replays it too. No
        # lock needed here: we are still single-threaded in the constructor.
        if self.brief:
            self._append("system", self.brief, sys=True)

    def set_on_close(self, cb: Callable[[str], None]) -> None:
        self._on_close = cb

    # -- helpers (all called with self.lock held) --------------------------

    def _append(self, handle: str, body: str, sys: bool) -> dict:
        """Append one entry to the log and return it. Bumps the sequence."""
        entry = {
            "seq": len(self.log) + 1,
            "handle": handle,
            "body": body,
            "ts": time.time(),
            "sys": sys,
        }
        self.log.append(entry)
        return entry

    def _close(self, reason: str) -> None:
        """THE single close funnel. Every way the conversation can end -- turn
        cap, wall-clock cap, repetition kill, or last-peer-out -- routes through
        here while holding self.lock.

        It (1) marks closed, (2) posts the 'conversation closed' notice once
        (idempotent), and (3) UNCONDITIONALLY wakes every parked /recv via
        notify_all. The notify is outside the `if not self.closed` guard on
        purpose: a second close attempt must STILL wake any waiter that managed
        to park between the first close and now, so no /recv can outlive close
        by more than the moment it takes to reacquire the lock.

        Callers hold self.lock (the Condition's lock), so a waiter cannot be
        mid-`cond.wait` re-check while we run -- the wake can't be lost.

        After waking waiters we fire the one-shot _on_close callback (the
        process exit) from a short-lived daemon thread so it runs OUTSIDE this
        lock and after parked /recv calls have had their moment to drain."""
        first_close = not self.closed
        if first_close:
            self.closed = True
            self.close_reason = reason
            self._append("system", f"conversation closed: {reason}", sys=True)
        # Release EVERY long-poller, every time. Cheap and idempotent.
        self.cond.notify_all()
        # Fire the process-exit callback exactly once, off-lock, after a short
        # grace so parked /recv threads wake, see the log, and respond first.
        if first_close and self._on_close is not None:
            cb = self._on_close

            def _later() -> None:
                time.sleep(0.4)  # let parked /recv calls return the closed signal
                cb(reason)

            threading.Thread(target=_later, name="wire-shutdown", daemon=True).start()

    def _wall_expired(self) -> bool:
        return self.started_at is not None and (time.time() - self.started_at) >= MAX_SECONDS

    # -- jack / unplug -----------------------------------------------------

    def join(self) -> tuple[str, str, int]:
        """Mint an opaque token + display handle for a new peer. The peer's
        cursor starts at the START of the log (0), so its FIRST /recv returns the
        whole conversation so far (the backlog) and only then does it block for
        new messages. This matters when the host posts ("hello, let's discuss X")
        and THEN hands over the jack URL: the late joiner must see that opener
        immediately, not sit blocked waiting for the next post. Subsequent scans
        advance the cursor as normal and return only new messages. Returns
        (token, handle, peer_count_before_this_join)."""
        with self.lock:
            peers_before = len(self.peers)
            # Mint a token unique among peers (3 bytes -> 6 hex chars).
            while True:
                token = secrets.token_hex(3)
                if token not in self.peers:
                    break
            self._handle_n += 1
            handle = f"peer-{self._handle_n}"
            self.peers[token] = {"handle": handle, "cursor": 0}
            self._any_joined = True
            # Presence: announce the join as a system event, mirroring leave's
            # "<handle> left" notice. Inside the lock, same as leave's _append.
            self._append("system", f"{handle} joined", sys=True)
            return token, handle, peers_before

    def leave(self, token: str, reason: str = "") -> bool:
        """A peer leaves. Posts a system '<handle> left' notice and drops the
        token. The conversation stays alive while >=1 peer remains; it closes
        (and the process exits) when the last peer departs. Returns False if the
        token is unknown."""
        with self.lock:
            peer = self.peers.pop(token, None)
            if peer is None:
                return False
            note = f"{peer['handle']} left"
            if reason:
                note += f" ({reason})"
            # Authored as "system" (like the closure notice) -- it's a relay
            # event, not a peer utterance. The body names the departing handle.
            self._append("system", note, sys=True)
            if not self.peers and self._any_joined:
                # Last one out closes the conversation -> process exits.
                self._close("all peers left")
            self.cond.notify_all()
            return True

    # -- send (append) -----------------------------------------------------

    def send(self, token: str, body: str, last: int | None = None) -> tuple[int, dict]:
        """Append a peer's message to the shared log and wake all long-pollers.
        Enforces the caps. Returns (http_status, json_payload).

        On a successful append the response also carries CROSS-DETECTION fields:
        `missed` is every log entry the caller has not yet recv'd (seq > its read
        cursor) authored by SOMEONE ELSE -- i.e. posts that crossed the wire with
        this one -- in order, same shape as recv entries; `crossed` is just
        bool(missed). This is informational ONLY: it does NOT advance the caller's
        read cursor. recv stays the SOLE mover of a peer's read position, so every
        `missed` entry is STILL delivered on the caller's next recv. Echo informs;
        recv delivers.

        OPT-IN CURSOR-CHECKED SEND: `last` is the highest seq the caller claims to
        have seen (from ?last=<seq>). When given, it PREVENTS talking over others:
        if ANY entry exists with seq > last authored by SOMEONE ELSE, the post is
        REFUSED (409 "behind") and we hand back `latest` + the `missed` posts
        instead of appending blind -- the caller should recv those, then retry. When
        `last is None` (the default) there is NO guard and behavior is exactly as
        before -- fully backward-compatible. The check is independent of the per-peer
        cursor; it trusts only the seq the caller passes."""
        with self.lock:
            peer = self.peers.get(token)
            if peer is None:
                return 401, {"ok": False, "error": "unknown token (did you /jack?)"}
            if self.closed:
                return 409, {"ok": False, "error": f"conversation closed: {self.close_reason}"}

            body = body.rstrip("\n")
            if not body.strip():
                return 400, {"ok": False, "error": "empty body"}

            # OPT-IN CURSOR GUARD (?last=<seq>): refuse to post over unread posts.
            # If the caller pinned the highest seq it has seen and SOMEONE ELSE has
            # since posted past it, don't append -- hand back the latest seq + the
            # missed posts so the caller can recv them first, then retry. last=None
            # skips this entirely (legacy behavior). Same `missed` shape as below.
            if last is not None:
                missed = [
                    {"seq": e["seq"], "handle": e["handle"], "body": e["body"], "ts": e["ts"]}
                    for e in self.log
                    if e["seq"] > last and e["handle"] != peer["handle"]
                ]
                if missed:
                    latest = self.log[-1]["seq"] if self.log else 0
                    return 409, {"ok": False, "error": "behind", "latest": latest, "missed": missed}

            now = time.time()
            if self.started_at is None:
                self.started_at = now

            # --- CAP 1: wall-clock. Refuse + close once the clock is up. ----
            if self._wall_expired():
                self._close(f"wall-clock cap ({MAX_SECONDS}s)")
                return 409, {"ok": False, "error": f"conversation closed: {self.close_reason}"}

            # --- CAP 2: repetition kill. If this normalized body matches the
            # previous accepted one, count the run; REPEAT_WINDOW in a row means
            # the exchange has stalled. We still record THIS post, then close so
            # the next /recv delivers the closure notice and further /send 409s.
            n = _norm(body)
            if self.recent_norm and self.recent_norm[-1] == n:
                self.recent_norm.append(n)
            else:
                self.recent_norm = [n]

            entry = self._append(peer["handle"], body, sys=False)
            self.turns += 1

            if len(self.recent_norm) >= REPEAT_WINDOW:
                self._close("stalled/repetition")
            # --- CAP 3: turn cap. Closing AFTER recording the trips-it post,
            # so the cap'th message still lands, then no further posts accepted.
            elif self.turns >= MAX_TURNS:
                self._close(f"turn cap ({MAX_TURNS} messages)")

            # Wake everyone parked on /recv: there is new content (this post,
            # and possibly a closure notice) for them to drain.
            self.cond.notify_all()

            # Cross-detection: others' posts the caller hasn't recv'd yet (seq
            # past its cursor, authored by someone else). The caller's own just-
            # appended entry is excluded by the handle check. We deliberately do
            # NOT touch peer["cursor"] -- recv remains the only cursor mover, so
            # these entries are still delivered on the caller's next recv.
            cur = peer["cursor"]
            missed = [
                {"seq": e["seq"], "handle": e["handle"], "body": e["body"], "ts": e["ts"]}
                for e in self.log
                if e["seq"] > cur and e["handle"] != peer["handle"]
            ]
            return 200, {
                "ok": True,
                "seq": entry["seq"],
                "handle": peer["handle"],
                "crossed": bool(missed),
                "missed": missed,
            }

    # -- recv (long-poll read) --------------------------------------------

    def _caught_up(self, peer: dict) -> bool:
        """Has every OTHER connected peer already read this peer's latest post?
        Called with self.lock held. True iff every other peer's cursor is >= the
        seq of this caller's last authored (non-system) log entry -- i.e. everyone
        has seen the caller's most recent message. Edge cases that count as caught
        up: the caller has never posted (nothing to be behind on), or the caller is
        the only peer here (no one else to be waiting on)."""
        # Find the caller's last authored (non-system) entry by scanning back.
        my_handle = peer["handle"]
        last_mine = 0
        for e in reversed(self.log):
            if not e["sys"] and e["handle"] == my_handle:
                last_mine = e["seq"]
                break
        if last_mine == 0:
            return True  # never posted -> nobody can be behind on us
        for other in self.peers.values():
            if other is peer:
                continue
            if other["cursor"] < last_mine:
                return False
        return True

    def recv(self, token: str, wait: float) -> tuple[int, object]:
        """LONG-POLL. Block up to `wait` seconds until the log has entries past
        this token's cursor, then return them as a list and advance the cursor.
        Returns (status, payload):
          * (200, [entries...])  -- one or more new messages (may include the
                                    system 'conversation closed' notice).
          * (200, {"system": "conversation closed: <reason>"})
                                 -- the conversation is CLOSED and this peer has
                                    already drained the log. An UNAMBIGUOUS
                                    terminal signal: the client must stop.
          * (200, {"idle": True, "cursor": N, "peers": M, "caught_up": BOOL})
                                 -- the long-poll timed out with nothing new on a
                                    STILL-OPEN conversation. A 200 HEARTBEAT (not
                                    a 204, not a dropped socket): cursor is the
                                    caller's read position, peers the connected
                                    count, caught_up whether everyone else has
                                    seen the caller's latest post. The client just
                                    re-runs recv.

        The closed case never blocks and never returns the idle heartbeat: once
        closed, /recv returns the closed payload immediately so no waiter can hang
        and no client is tricked into re-polling a dead conversation. This is the
        deadlock fix.

        This is the heart of the "peer side stays trivial" promise: the server
        holds the connection open and holds the cursor, so the agent just
        re-runs the same `recv` curl each turn -- no bash loop, no cursor math.
        """
        deadline = time.time() + wait
        with self.lock:
            peer = self.peers.get(token)
            if peer is None:
                return 401, {"ok": False, "error": "unknown token (did you /jack?)"}

            while True:
                # Anything in the log past our cursor? (covers normal posts AND
                # the system closure notice, so a closing conversation drains.)
                if len(self.log) > peer["cursor"]:
                    new = self.log[peer["cursor"] :]
                    peer["cursor"] = self.log[-1]["seq"]  # advance to latest seq
                    out = [
                        {
                            "seq": e["seq"],
                            "handle": e["handle"],
                            "body": e["body"],
                            "ts": e["ts"],
                            "is_me": e["handle"] == peer["handle"],
                        }
                        for e in new
                    ]
                    return 200, out

                # Nothing new past the cursor. If CLOSED, there will never be
                # anything new -> return the explicit terminal signal IMMEDIATELY
                # (no wait, no 204). A freshly-arriving recv on an already-closed
                # conversation hits this on the first loop iteration; a parked
                # recv hits it the instant _close()'s notify_all wakes it. Either
                # way the client gets a clear "closed" and stops.
                if self.closed:
                    return 200, {"system": f"conversation closed: {self.close_reason}"}

                # Sleep on the condition until /send, /unplug, or _close
                # notifies us, or until the deadline. cond.wait releases the lock
                # while parked and reacquires it on wake -- so this never burns
                # CPU and never blocks other requests (each request runs in its
                # own thread). Because _close() runs under this same lock and
                # calls notify_all, a close that happens while we hold the lock
                # here cannot interleave, and one that happens while we are
                # parked wakes us -- the wake is never lost.
                remaining = deadline - time.time()
                if remaining <= 0:
                    # Timed out with nothing new on a STILL-OPEN conversation.
                    # Answer with a 200 idle HEARTBEAT (not a 204): the client
                    # learns the relay is alive + quiet and just re-runs recv.
                    return 200, {
                        "idle": True,
                        "cursor": peer["cursor"],
                        "peers": len(self.peers),
                        "caught_up": self._caught_up(peer),
                        "peers_list": sorted(p["handle"] for p in self.peers.values()),
                        "is_last_peer": len(self.peers) == 1,
                    }
                self.cond.wait(timeout=remaining)

    # -- trace -------------------------------------------------------------

    def history(self) -> str:
        """Render the full ordered log as human-readable plain text."""
        with self.lock:
            head = "=== wire conversation" + (f" -- topic: {self.topic}" if self.topic else "") + " ==="
            lines = [head]
            for e in self.log:
                stamp = time.strftime("%H:%M:%S", time.localtime(e["ts"]))
                tag = "**" if e["sys"] else "  "
                lines.append(f"[{stamp}] {tag}{e['handle']}: {e['body']}")
            if self.closed:
                lines.append(f"--- closed: {self.close_reason} ---")
            return "\n".join(lines) + "\n"

    # -- peers -------------------------------------------------------------

    def peers_list(self) -> dict:
        """Who's currently connected, plus conversation status."""
        with self.lock:
            return {
                "peers": sorted(p["handle"] for p in self.peers.values()),
                "count": len(self.peers),
                "closed": self.closed,
                "close_reason": self.close_reason,
                "turns": self.turns,
                "topic": self.topic,
            }


# The ONE conversation for this process. Topic comes from RELAY_TOPIC if set;
# the topic brief from RELAY_BRIEF (a --brief argv value overrides it in main()).
CONVO = Conversation(os.environ.get("RELAY_TOPIC", ""), os.environ.get("RELAY_BRIEF", ""))


# ===========================================================================
# The personalized MANUAL. This text IS the product's UX: it's the only thing
# a fresh agent needs to participate. Curl commands come pre-filled with token.
# ===========================================================================
def build_manual(
    convo: Conversation, token: str, handle: str, peers_before: int, host: str, port: int, secret: str
) -> str:
    base = f"http://{host}:{port}"
    peer_word = "peer" if peers_before == 1 else "peers"
    topic_line = f"Topic: {convo.topic}\n" if convo.topic else ""
    # When a brief was seeded, surface it as a TOPIC block up top -- a remote
    # peer reads this manual BEFORE its first /recv, so the topic must be visible
    # here too (the full brief also rides the log as the seq-1 system entry). The
    # brief is rendered verbatim, multiline and all.
    topic_block = f"TOPIC -- what this discussion is about:\n{convo.brief}\n\n" if convo.brief else ""
    return f"""\
You are {handle}. {peers_before} {peer_word} currently here.
{topic_line}
{topic_block}This is a live GROUP chat over a shared message log. Everyone reads the same
log; anything you post is seen by all. Your hidden token is {token} -- it is
already filled into the commands below. Do not share it; do not pass any name
or number anywhere. The server tracks your read position for you. The commands
also carry a shared access key (k=...) -- it's already filled in; leave it.

Handles (peer-1, peer-2, ...) are stable and only ever count UP; the peer COUNT
is who is here RIGHT NOW. Seeing a peer-4 while you are peer-3 and only "2 here"
is NOT a bug -- earlier peers left, their numbers are not reused.

YOUR THREE COMMANDS (copy-paste; these work in bash, cmd, and PowerShell):

  recv:    curl -s --max-time 600 "{base}/recv?t={token}&k={secret}"
  send:    curl -s -X POST "{base}/send?t={token}&k={secret}" --data-binary 'YOUR MESSAGE'
  unplug:  curl -s "{base}/unplug?t={token}&k={secret}"

HOW TO PARTICIPATE (this is your job until the task is done):
  Run recv. Your FIRST recv returns the conversation SO FAR (everything posted
  before you joined) as a JSON array -- read it to catch up. After that, recv
  BLOCKS until someone posts, then returns the new messages. If you have
  something to add, run send, then run recv again. Repeat. That re-running of
  recv is the entire loop -- no script needed.

  (If nothing new arrives for ~25s, recv returns a 200 idle HEARTBEAT -- a JSON
  object {{"idle": true, "cursor": N, "peers": M, "caught_up": <bool>}} -- so a
  quiet line never looks like a dropped connection. That is normal: just run recv
  again. The recv command's --max-time is well above that window, so the server
  always answers first. caught_up tells you whether everyone else has read your
  latest post yet -- use it to gauge whether the group has seen what you last
  said before you decide to post again.)

  Note: recv returns ALL new messages including your OWN posts, echoed back.
  Each entry carries an "is_me" flag -- skip the entries where "is_me" is true
  and respond only to others'.

  send's reply also reports crossings: {{"ok": true, "seq": S, "handle": H,
  "crossed": <bool>, "missed": [ ...entries... ]}}. This is the REACTIVE signal --
  you have ALREADY posted: `crossed` true means someone posted while you were
  typing and `missed` lists those posts. `missed` is safe to read and act on
  directly; every entry in it is also redelivered on your next recv, so you lose
  nothing either way.

  To PREVENT talking over others instead of just noticing after the fact, add
  ?last=<highest seq you've seen> to send:
    curl -s -X POST "{base}/send?t={token}&k={secret}&last=<seq>" --data-binary 'MSG'
  If anyone has posted past that seq, send is REFUSED with HTTP 409
  {{"ok": false, "error": "behind", "latest": <seq>, "missed": [ ...entries... ]}}
  and your message is NOT posted -- recv those missed posts, then send again,
  rather than posting blind.

  If recv ever returns a conversation-closed system message (a JSON object with
  a `system` field, e.g. {{"system": "conversation closed: ..."}}), the
  conversation is OVER. STOP. Do not run recv or send again.

ETIQUETTE -- READ THIS:
  Only post when you ADD something. Do NOT post acknowledgement-only or
  pleasantry messages. If you have nothing to add, just run recv again. When
  the task is resolved, run unplug. Unplug is FINAL for this session -- there is
  no rejoin; everyone else sees a "{handle} left" line when you go.

Re-read or watch the whole thread anytime (no token, doesn't move your position):
  curl -s "{base}/trace?k={secret}"

See who is here right now (key only, no token):
  curl -s "{base}/peers?k={secret}"
Joins and leaves also arrive inline as system messages ("{handle} joined" /
"<handle> left"), so a plain recv loop already tells you who comes and goes.

(The k=... key keeps strangers out, not sniffers -- this is plain HTTP.)
"""


# ===========================================================================
# HTTP handler. ThreadingHTTPServer gives each request its own thread, so a
# long-polling /recv never blocks other requests.
# ===========================================================================
class Handler(BaseHTTPRequestHandler):
    server_version = "WireRelay/1.0"
    protocol_version = "HTTP/1.1"  # keep-alive + proper Content-Length framing

    # Silence the default noisy per-request stderr logging; we print our own.
    def log_message(self, fmt: str, *args: Any) -> None:
        pass

    # -- tiny response helpers --------------------------------------------

    def _send(self, status: int, body: bytes, ctype: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _text(self, status: int, text: str) -> None:
        self._send(status, text.encode("utf-8"), "text/plain; charset=utf-8")

    def _json(self, status: int, obj: Any) -> None:
        self._send(status, json.dumps(obj).encode("utf-8"), "application/json")

    # -- the host:port to advertise in manuals. We use the Host header the
    # client actually reached us on when present (so a LAN IP shows up
    # correctly), falling back to configured host/port.
    def _advertised(self) -> tuple[str, int]:
        host_hdr = self.headers.get("Host", "")
        if host_hdr:
            if ":" in host_hdr:
                h, _, p = host_hdr.partition(":")
                return h, int(p) if p.isdigit() else PORT
            return host_hdr, PORT
        adv_host = "127.0.0.1" if HOST in ("0.0.0.0", "") else HOST
        return adv_host, PORT

    # -- soft-gate key check ----------------------------------------------
    # Constant-time compare of the ?k=<secret> query param against the process
    # SECRET. This is the SOFT GATE: it stops casual discovery, not a sniffer
    # (plain HTTP, key in cleartext). It is INDEPENDENT of the per-peer token --
    # a gated route checks the key here, THEN (if it also needs one) the token in
    # the Conversation method. /health is the only ungated route.
    @staticmethod
    def _key_ok(qs: dict) -> bool:
        supplied = qs.get("k", [""])[0]
        return hmac.compare_digest(supplied, SECRET)

    # -- GET ---------------------------------------------------------------

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        # /health is the ONE open route -- no key. The uplink double-start guard
        # and the eject down-check probe it without knowing the secret.
        if path == "/health":
            return self._text(200, "ok\n")

        if path == "/jack":
            # /jack returns text, so its 401 is a short text body (not JSON).
            if not self._key_ok(qs):
                return self._text(401, "bad or missing key\n")
            token, handle, peers_before = CONVO.join()
            host, port = self._advertised()
            print(f"[jack] handle={handle} token={token} (peers now {peers_before + 1})")
            return self._text(200, build_manual(CONVO, token, handle, peers_before, host, port, SECRET))

        if path == "/recv":
            # Key gate FIRST, then the per-peer token -- the two are independent.
            if not self._key_ok(qs):
                return self._json(401, {"ok": False, "error": "bad or missing key"})
            token = qs.get("t", [""])[0]
            if not token:
                return self._json(400, {"ok": False, "error": "missing ?t=<token>"})
            wait = self._clamp_wait(qs.get("wait", [str(DEFAULT_WAIT)])[0])
            status, payload = CONVO.recv(token, wait)
            return self._json(status, payload)

        if path == "/unplug":
            if not self._key_ok(qs):
                return self._json(401, {"ok": False, "error": "bad or missing key"})
            token = qs.get("t", [""])[0]
            if not token:
                return self._json(400, {"ok": False, "error": "missing ?t=<token>"})
            reason = qs.get("reason", [""])[0]
            ok = CONVO.leave(token, reason)
            print(f"[unplug] token={token} ok={ok} reason={reason!r}")
            return self._json(200 if ok else 401, {"ok": ok})

        if path == "/trace":
            # Key-only gate -- this is what closes the old "anyone reads the whole
            # log with no credential" hole.
            if not self._key_ok(qs):
                return self._json(401, {"ok": False, "error": "bad or missing key"})
            return self._text(200, CONVO.history())

        if path == "/peers":
            if not self._key_ok(qs):
                return self._json(401, {"ok": False, "error": "bad or missing key"})
            return self._json(200, CONVO.peers_list())

        return self._text(404, "not found\n")

    # -- POST --------------------------------------------------------------

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == "/send":
            if not self._key_ok(qs):
                return self._json(401, {"ok": False, "error": "bad or missing key"})
            token = qs.get("t", [""])[0]
            if not token:
                return self._json(400, {"ok": False, "error": "missing ?t=<token>"})
            body = self._read_body()
            # Optional ?last=<seq>: opt-in cursor-checked send. Parse to int; a
            # missing/garbage value stays None -> the legacy (unguarded) path.
            last = None
            raw_last = qs.get("last", [""])[0]
            if raw_last:
                with contextlib.suppress(ValueError):
                    last = int(raw_last)
            status, payload = CONVO.send(token, body, last)
            return self._json(status, payload)

        return self._text(404, "not found\n")

    # -- request helpers ---------------------------------------------------

    def _read_body(self) -> str:
        """Read the POST body. Accept either a raw body or JSON {"body": "..."}.
        We sniff for JSON only when it parses to a dict containing 'body'."""
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b""
        text = raw.decode("utf-8", "replace")
        stripped = text.strip()
        if stripped.startswith("{") and stripped.endswith("}"):
            try:
                obj = json.loads(stripped)
                if isinstance(obj, dict) and "body" in obj:
                    return str(obj["body"])
            except (ValueError, TypeError):
                pass  # not JSON we understand -> treat as raw text
        return text

    @staticmethod
    def _clamp_wait(raw: str) -> float:
        try:
            w = float(raw)
        except (ValueError, TypeError):
            w = DEFAULT_WAIT
        # Clamp to [0, IDLE_WAIT]: the server's idle ceiling wins even when the
        # client asks for the legacy 600s, so a quiet recv returns a 200 idle
        # heartbeat at ~IDLE_WAIT (well under the client's curl --max-time) rather
        # than holding the socket until it looks dropped. MAX_WAIT stays the
        # absolute backstop in case IDLE_WAIT is ever raised above it.
        return max(0.0, min(w, IDLE_WAIT, MAX_WAIT))


# NOTE: the pid is written by _claim_pidfile_lock() (the O_EXCL lock claim in
# main()), not a separate _write_pidfile -- the write and the lock are one atomic
# step so two relays for the same room can't both think they own it.


def _remove_pidfile() -> None:
    with contextlib.suppress(OSError):
        Path(PIDFILE).unlink()


def _write_portfile(port: int) -> None:
    """Record the actually-bound port so `uplink`/`eject` can find it. Best-effort
    -- a failure here must not stop the relay from serving."""
    try:
        Path(PORTFILE).write_text(str(port))
    except OSError as e:
        print(f"[warn] could not write portfile {PORTFILE}: {e}", file=sys.stderr)


def _remove_portfile() -> None:
    with contextlib.suppress(OSError):
        Path(PORTFILE).unlink()


def _write_secretfile(secret: str) -> None:
    """Record the shared secret so `uplink` can bake ?k=<secret> into the host's
    own curls and the colleague hand-off line. It is a CREDENTIAL: gitignored and
    written 0600. Best-effort -- a failure here must not stop the relay serving,
    but warn loudly since uplink relies on it."""
    try:
        secret_path = Path(SECRETFILE)
        secret_path.write_text(secret)
        with contextlib.suppress(OSError):
            secret_path.chmod(0o600)  # owner-only; best-effort
    except OSError as e:
        print(f"[warn] could not write secretfile {SECRETFILE}: {e}", file=sys.stderr)


def _remove_secretfile() -> None:
    with contextlib.suppress(OSError):
        Path(SECRETFILE).unlink()


def _bind_scanning(host: str, base_port: int) -> ThreadingHTTPServer:
    """Create and return a ThreadingHTTPServer bound to the first free port in
    [base_port, base_port + PORT_SCAN). Tries the base first; on EADDRINUSE it
    scans UPWARD one port at a time. Raises SystemExit with a clear message if
    all PORT_SCAN candidates are taken. Returns the bound server (its
    server_address carries the actual port)."""
    last_err = None
    for candidate in range(base_port, base_port + PORT_SCAN):
        try:
            return ThreadingHTTPServer((host, candidate), Handler)
        except OSError as e:
            if e.errno == errno.EADDRINUSE:
                last_err = e
                continue  # port busy -> try the next one up
            raise  # a different bind error (e.g. permission) -- don't mask it
    sys.exit(
        f"wire relay: no free port in {base_port}-{base_port + PORT_SCAN - 1} "
        f"on {host} (all {PORT_SCAN} busy). Last error: {last_err}"
    )


def _extract_brief(argv: list[str]) -> tuple[list[str], str | None]:
    """Pull an optional `--brief <value>` (or `--brief=<value>`) out of argv and
    return (argv_without_it, brief_or_None). The value is ONE argv token and is
    preserved VERBATIM, embedded newlines and all -- the shell already split it
    for us, so we never re-split or strip it here.

    We strip the flag BEFORE the positional `host port` parse so `--brief` can
    sit anywhere on the line without shifting the positional reads, and so the
    existing `relay.py 0.0.0.0 55555` launch (no flag) is completely unaffected.
    A trailing `--brief` with no value is ignored (treated as absent)."""
    out: list[str] = []
    brief: str | None = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--brief":
            if i + 1 < len(argv):
                brief = argv[i + 1]
                i += 2
            else:
                i += 1  # dangling --brief with no value -> ignore
            continue
        if a.startswith("--brief="):
            brief = a[len("--brief=") :]
            i += 1
            continue
        out.append(a)
        i += 1
    return out, brief


def _extract_secret(argv: list[str]) -> tuple[list[str], str | None]:
    """Pull an optional `--secret <value>` (or `--secret=<value>`) out of argv and
    return (argv_without_it, secret_or_None). Mirrors _extract_brief exactly: the
    flag is stripped BEFORE the positional `host port` parse, so --secret can sit
    anywhere on the line (the `relay.py 0.0.0.0 55555` and the nohup launch are
    unaffected) and coexists with --brief on one launch. A dangling `--secret`
    with no value is ignored (treated as absent -> fall through to env/generate)."""
    out: list[str] = []
    secret: str | None = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--secret":
            if i + 1 < len(argv):
                secret = argv[i + 1]
                i += 2
            else:
                i += 1  # dangling --secret with no value -> ignore
            continue
        if a.startswith("--secret="):
            secret = a[len("--secret=") :]
            i += 1
            continue
        out.append(a)
        i += 1
    return out, secret


def _extract_room(argv: list[str]) -> tuple[list[str], str | None]:
    """Pull an optional `--room <value>` (or `--room=<value>`) out of argv and
    return (argv_without_it, room_or_None). Mirrors _extract_secret/_extract_brief:
    the flag is stripped BEFORE the positional `host port` parse, so --room can sit
    anywhere on the line and coexist with --brief/--secret. A dangling `--room`
    with no value is ignored (treated as absent -> fall through to RELAY_ROOM env).

    NOTE: we strip --room only from the parse list we hand the positional reader;
    the LAUNCHED process keeps --room in its real cmdline, so `ps` still shows it
    and /eject's scoped `pkill -f "relay\\.py.*--room <id>"` can match it."""
    out: list[str] = []
    room: str | None = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--room":
            if i + 1 < len(argv):
                room = argv[i + 1]
                i += 2
            else:
                i += 1  # dangling --room with no value -> ignore
            continue
        if a.startswith("--room="):
            room = a[len("--room=") :]
            i += 1
            continue
        out.append(a)
        i += 1
    return out, room


def _claim_pidfile_lock() -> None:
    """Claim PIDFILE atomically as a per-room startup LOCK, closing the
    double-start race. Called at the START of main() -- after room+paths are
    resolved, BEFORE the bind/port-scan -- so two relays for the SAME room+dir
    cannot both proceed to bind.

    O_CREAT|O_EXCL makes the create fail if the file already exists:
      * success            -> we own this room; write our pid, return (proceed to bind).
      * FileExistsError     -> read the pid already in the file:
          - alive (os.kill(pid,0) ok)  -> another relay owns this room. Print
            `room <id> already up` (with the port from the portfile if readable)
            to stderr and sys.exit(1) WITHOUT binding.
          - stale/dead (os.kill raises) -> remove the file and retry the EXCL
            claim ONCE. If the retry still collides, treat it as live (a real
            racer just won) and refuse.

    The portfile/secretfile are still written later (after bind -- they need the
    bound port); _on_close / the finally both still remove all three."""
    room_label = ROOM if ROOM else "default"
    for _attempt in range(2):  # original claim + at most one stale-reclaim retry
        try:
            fd = os.open(PIDFILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            # Someone holds (or held) the lock. Is that process still alive?
            try:
                existing = int(Path(PIDFILE).read_text().strip() or "0")
            except (OSError, ValueError):
                existing = 0
            alive = False
            if existing > 0:
                try:
                    os.kill(existing, 0)
                    alive = True
                except ProcessLookupError:
                    alive = False
                except PermissionError:
                    alive = True  # exists but owned by another user -> treat as live
            if alive:
                port_hint = ""
                try:
                    p = Path(PORTFILE).read_text().strip()
                    if p:
                        port_hint = f" on :{p}"
                except OSError:
                    pass
                print(
                    f"wire relay: room {room_label} already up{port_hint} "
                    f"(pid {existing}) -- not starting a second one.",
                    file=sys.stderr,
                )
                sys.exit(1)
            # Stale/dead pid -> reclaim the lock file and retry the EXCL claim once.
            with contextlib.suppress(OSError):
                Path(PIDFILE).unlink()
            continue
        else:
            # We own the lock. Record our pid and release the fd.
            try:
                os.write(fd, str(os.getpid()).encode("ascii"))
            finally:
                os.close(fd)
            return
    # Both attempts collided with a live-looking holder (a real racer won the
    # retry). Refuse rather than race onto another port.
    print(
        f"wire relay: room {room_label} already up -- not starting a second one.",
        file=sys.stderr,
    )
    sys.exit(1)


def main() -> None:
    global HOST, PORT, SECRET, ROOM, PIDFILE, PORTFILE, SECRETFILE
    # Strip --brief, --secret AND --room first so none disturbs the positional
    # host/port parse. All three can sit anywhere on the line and coexist on one
    # launch; what's left in `args` is just the positional host/port (if any).
    args, brief = _extract_brief(sys.argv[1:])
    args, secret = _extract_secret(args)
    args, room = _extract_room(args)

    # Resolve the room EARLY (argv --room > RELAY_ROOM env > none) and recompute
    # the state-file globals with it BEFORE any write and before _on_close is
    # wired -- so the pidfile lock, the port/secret writes, and the cleanup all
    # act on the room-namespaced paths. The per-file RELAY_*FILE overrides still
    # win inside _resolve_statefiles (keeps the verify harness's older proofs and
    # anything else relying on them working unchanged).
    if room is not None:
        ROOM = room
    PIDFILE, PORTFILE, SECRETFILE = _resolve_statefiles(ROOM)

    if brief is not None:
        # A --brief value overrides any RELAY_BRIEF env. Re-seed by rebuilding the
        # conversation (it's still empty/unbound here, before any peer can join).
        CONVO.brief = brief.rstrip("\n")
        CONVO.log.clear()
        if CONVO.brief:
            CONVO._append("system", CONVO.brief, sys=True)
    # Resolve the shared secret: argv --secret wins, else RELAY_SECRET env (seeded
    # into SECRET at import), else self-generate 32 hex chars. So a bare launch
    # with no flag and no env STILL starts -- it just mints its own key.
    if secret is not None:
        SECRET = secret
    if not SECRET:
        SECRET = secrets.token_hex(16)
    # argv overrides env: `python3 relay.py [host] [port]` (brief+secret+room removed)
    if len(args) >= 1:
        HOST = args[0]
    if len(args) >= 2:
        PORT = int(args[1])

    # Claim the per-room pidfile LOCK before touching the port -- this is the
    # double-start fence. If another relay already owns this room it refuses here
    # (exit 1) WITHOUT binding; a stale pidfile (dead pid) is reclaimed. On
    # success the pidfile already holds our pid.
    _claim_pidfile_lock()

    # Bind the first free port at/above PORT (our scan base). The actual bound
    # port may be higher than the base if the base was busy; adopt it as PORT so
    # the manual, logs, and portfile all advertise the real port. If the bind
    # fails (no free port, permission, ...) we MUST drop the pidfile lock we just
    # claimed, or it would wedge this room for the next start.
    try:
        server = _bind_scanning(HOST, PORT)
    except BaseException:
        _remove_pidfile()
        raise
    PORT = server.server_address[1]

    # The conversation's close funnel triggers a clean PROCESS EXIT: one
    # conversation per process, so when it ends, we end. The callback runs off
    # the conversation lock (see _close), shuts the server down from a separate
    # thread (shutdown() must not be called from a request thread), removes the
    # pid/port files, and lets main()'s serve_forever() return.
    def _on_close(reason: str) -> None:
        print(f"[close] {reason} -- conversation over, shutting down.")
        _remove_pidfile()
        _remove_portfile()
        _remove_secretfile()

        def _stop() -> None:
            server.shutdown()  # unblocks serve_forever() in the main thread

        threading.Thread(target=_stop, name="wire-server-stop", daemon=True).start()

    CONVO.set_on_close(_on_close)

    # Pidfile was already written when we claimed the lock above; now that we have
    # the bound port + resolved secret, write those two (they could not be written
    # before the bind). Cleanup (_on_close + the finally) removes all three.
    _write_portfile(PORT)
    _write_secretfile(SECRET)
    adv = "127.0.0.1" if HOST in ("0.0.0.0", "") else HOST
    room_note = f" room={ROOM}" if ROOM else ""
    print(f"wire relay listening on {HOST}:{PORT}  (pid {os.getpid()}){room_note}")
    print(f"  secret : {SECRET}  (soft gate -- ?k=<secret> on every route but /health)")
    print(f"  health : curl -s http://{adv}:{PORT}/health")
    print(f'  jack   : curl -s "http://{adv}:{PORT}/jack?k={SECRET}"')
    print(f'  watch  : curl -s "http://{adv}:{PORT}/trace?k={SECRET}"')
    print(f"  caps   : turns={MAX_TURNS} wall={MAX_SECONDS}s repeat-window={REPEAT_WINDOW}")

    # Cleanup the state files on EVERY exit path, not just the clean ones. Without
    # this a SIGTERM (the default `kill`, and how a parent reaps us) stranded the
    # pid/port/secret files, wedging the room for the next start. atexit covers
    # normal returns + sys.exit; the SIGTERM handler turns the signal into a clean
    # exit so atexit fires. The _remove_* helpers suppress OSError, so cleanup is
    # idempotent -- running it from atexit AND the finally below is harmless.
    def cleanup() -> None:
        _remove_pidfile()
        _remove_portfile()
        _remove_secretfile()

    atexit.register(cleanup)
    signal.signal(signal.SIGTERM, lambda *_: (cleanup(), sys.exit(0)))

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down (interrupt)")
        server.shutdown()
    finally:
        cleanup()
    print("wire relay stopped.")


if __name__ == "__main__":
    main()
