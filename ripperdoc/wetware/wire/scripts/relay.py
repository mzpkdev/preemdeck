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
    python3 relay.py 0.0.0.0 9000 --public-base https://x.ngrok-free.app   # advertise a proxy URL in /jack
    RELAY_PUBLIC_BASE=https://x.ngrok-free.app python3 relay.py   # same, via env

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
MAX_TURNS = int(os.environ.get("RELAY_MAX_TURNS", "200"))  # total accepted posts
MAX_SECONDS = int(os.environ.get("RELAY_MAX_SECONDS", "1800"))  # wall clock from 1st post
REPEAT_WINDOW = int(os.environ.get("RELAY_REPEAT_WINDOW", "3"))  # N consecutive near-dupes -> stall
# Hard ceiling on a single POST body, in bytes (default 64 KiB; 0 = unlimited).
# Enforced inside the ONE body-read choke point (_read_body) so it caps BOTH the
# raw-body and {"body": "..."} paths -- and any future parse layered on the body
# read (e.g. a later addressing envelope) inherits the cap for free. An oversized
# body is rejected (HTTP 413) BEFORE it is allocated/read, not after.
MAX_BODY = int(os.environ.get("RELAY_MAX_BODY", "65536"))  # max /send body bytes (0 = unlimited)
# Per-peer minimum gap between accepted /send posts, in seconds (float; default
# 0 = OFF, full back-compat). Distinct from the repetition kill (which only fires
# on identical-consecutive bodies) and the turn cap (total volume): this throttles
# how FAST one peer may post, regardless of content. Keyed off a per-peer last_send
# monotonic stamp that is SEPARATE from last_seen, so mere recv-polling never resets
# the gate; only an ACCEPTED post advances it.
MIN_SEND_INTERVAL = float(os.environ.get("RELAY_MIN_SEND_INTERVAL", "0"))  # min secs between a peer's posts

# Backlog WINDOWING (RELAY_MAX_REPLAY). Caps how many RAW log entries a SINGLE
# /recv may deliver at once (default 0 = unlimited = today's behavior). When > 0
# and a recv would return more than N raw entries (e.g. a late joiner draining a
# long backlog, or a peer that fell far behind), recv hands back only the first N,
# advances the cursor to JUST that window's last seq (NOT the log tip), and wraps
# the batch in a truncation OBJECT {entries, truncated, remaining, next_since,
# hint} so the caller learns more is waiting. The plain re-run-recv loop then
# self-heals: each recv drains the next N-sized window, no gap, no dup. With the
# knob unset/0 a recv stays a BARE ARRAY (zero regression). next_since (= the last
# DELIVERED raw seq) is the continuity handle: a follow-up plain recv OR an
# explicit ?since=next_since resumes exactly where this window stopped.
MAX_REPLAY = int(os.environ.get("RELAY_MAX_REPLAY", "0"))  # max raw entries per /recv (0 = unlimited)

# Presence reaper. A peer is normally removed by an explicit /unplug, but a real
# agent whose process dies / drops its connection / stops polling would otherwise
# linger in `peers` forever -- poisoning caught_up / is_last_peer and, worst,
# keeping the room from ever auto-closing (peers never empties -> the process
# leaks). So each peer carries a last-seen timestamp (set at join, refreshed on
# every authenticated action -- the START of /recv and on /send), and a daemon
# REAPER thread drops any peer silent for longer than PEER_TIMEOUT. This MUST stay
# comfortably ABOVE IDLE_WAIT (25s): a healthy looping agent re-issues /recv at
# least every ~IDLE_WAIT (its long-poll returns by then with messages or a 200
# idle heartbeat), so 90s is ~3.6 missed heartbeats -- a live peer is NEVER reaped.
# REAP_INTERVAL is how often the thread wakes to sweep (short, so reaping is
# responsive relative to the timeout). The verify harness sets a tiny timeout so
# the reap proof runs fast.
PEER_TIMEOUT = int(os.environ.get("RELAY_PEER_TIMEOUT", "90"))  # drop a peer silent this long (s)
REAP_INTERVAL = 2.0  # how often the reaper thread sweeps for silent peers (s)
EMPTY_GRACE = int(
    os.environ.get("RELAY_EMPTY_GRACE", "120")
)  # secs an empty room lingers before self-close (0 = immediate)

# Advisory soft TURN-GRANT / floor-control lease (RELAY_FLOOR_LEASE). Default 0 =
# feature OFF -> byte-for-byte legacy: /floor still answers (floor_holder:null) but
# no turn fields populate and a non-caller sees nothing change. When > 0 it is the
# number of seconds a peer may HOLD the floor before the lease lapses and the floor
# auto-advances (FIFO head) or clears -- the anti-livelock backstop for a holder
# that hangs or dies without releasing. It is ADVISORY: /send is NEVER gated on the
# floor, so a peer that ignores /floor posts exactly as today; the floor only
# REPORTS whose turn it is (on the recv idle heartbeat + the send 200 reply). The
# lease is reclaimed LAZILY (no new thread) -- on the existing reaper clock
# (time.monotonic): checked at the top of send(), inside recv()'s wait loop, and
# once per reap_idle() sweep. Keep it comfortably BELOW PEER_TIMEOUT (the verify
# harness pins it a couple seconds, under the reap timeout) so a wedged holder is
# lease-reclaimed before -- or alongside -- the reaper dropping the dead peer.
FLOOR_LEASE = int(os.environ.get("RELAY_FLOOR_LEASE", "0"))  # secs a peer may hold the floor (0 = feature off)

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

# Public base URL advertised in the /jack manual. When set, it is used VERBATIM as
# the manual's {base} (trailing slash stripped so "{base}/recv" stays clean) and
# WINS over the per-request Host/X-Forwarded-Proto sniffing -- the escape hatch for
# running behind ngrok or any TLS reverse proxy that the header sniff can't infer.
# Resolved fully in main() (argv --public-base > RELAY_PUBLIC_BASE env > unset ->
# fall back to header derivation); this env seed just gives it a value if the
# module is imported without main() running.
PUBLIC_BASE = os.environ.get("RELAY_PUBLIC_BASE", "").rstrip("/")


def _norm(body: str) -> str:
    """Normalize a body for repetition comparison: lowercase + collapse all
    runs of whitespace. Two messages differing only in case/spacing are dupes.

    BODY-ONLY: the repetition kill compares ONLY the message body. The optional
    addressing envelope (to/reply_to/kind/role) never feeds this -- two identical
    bodies addressed differently are STILL dupes, so the envelope can't be used to
    slip past the stall guard."""
    return " ".join(body.lower().split())


# --- Optional message-envelope sanitizers ----------------------------------
# The relay is a DUMB PIPE for the addressing envelope: it carries/echoes these
# fields and offers an advisory ?mine= filter, but NEVER enforces routing and
# NEVER validates a `kind` against an enum (floor-control rides `kind` next
# stage -- it must stay free-form). Every field is OPTIONAL and OMITTED WHEN
# ABSENT, so a legacy raw-body or {"body":...} peer is byte-identical to before.
# Caps below are advisory hygiene only (keep one peer from flooding the field),
# not semantics.
ROLE_MAX = 24  # max chars for a peer's /jack ?role= label
TO_MAX_ITEMS = 8  # max recipients in a single `to` list
TO_ITEM_MAX = 24  # max chars per `to` handle
KIND_MAX = 16  # max chars for a message `kind` tag


def _norm_label(v: object, cap: int) -> str:
    """Sanitize a single free-text label (role / kind / a `to` element): coerce
    to str, strip surrounding whitespace, drop newlines (so it can't smuggle
    extra log lines or break /trace framing), and length-cap. Returns "" for a
    non-string or an empty-after-strip value -- callers treat "" as ABSENT."""
    if not isinstance(v, str):
        return ""
    s = v.replace("\n", " ").replace("\r", " ").strip()
    return s[:cap]


def _norm_to(v: object) -> list[str]:
    """Sanitize an addressing `to` value into a clean list[str]. A bare string is
    coerced to a 1-element list; a list is taken as-is. Each element is run
    through _norm_label (str-coerce, newline-strip, len-cap TO_ITEM_MAX) and
    dropped if it sanitizes to ""; the list is capped at TO_MAX_ITEMS. Anything
    else (int, dict, None, ...) yields []. The SAME helper is reused for the
    ?mine= membership test, so "addressed to me" means exactly what was stored."""
    if isinstance(v, str):
        items = [v]
    elif isinstance(v, list):
        items = v
    else:
        return []
    out: list[str] = []
    for item in items:
        lab = _norm_label(item, TO_ITEM_MAX)
        if lab:
            out.append(lab)
        if len(out) >= TO_MAX_ITEMS:
            break
    return out


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
        peers[token] = {"handle": str, "cursor": int, "last_seen": float}
    `cursor` is the seq of the last message this peer has already received. A
    long-polling /recv returns every log entry with seq > cursor, then sets
    cursor to the last seq returned. That is the entire "read position" model;
    agents never see or send a cursor. `last_seen` is a time.monotonic() stamp
    refreshed on every authenticated action (join, the start of /recv, /send);
    the reaper drops a peer whose last_seen is older than PEER_TIMEOUT.

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
        self.peers: dict[str, dict] = {}  # token -> {"handle", "cursor", "last_seen"}
        self._handle_n = 0  # monotonic counter for "peer-N" handles
        self._any_joined = False  # has at least one peer ever joined?
        # Grace-period self-close clock. None whenever >=1 peer is present (or no
        # peer has ever joined). Set to time.monotonic() the moment the room goes
        # empty (last peer leaves / is reaped); a (re)join clears it. Once it has
        # been non-None for >= EMPTY_GRACE secs the reaper self-closes the room.
        # Only ever touched under self.lock.
        self.empty_since: float | None = None  # monotonic stamp the room went empty (None = not empty)

        self.turns = 0  # count of accepted non-system posts
        self.started_at: float | None = None  # set on first accepted post
        self.closed = False
        self.close_reason: str | None = None
        self.recent_norm: list[str] = []  # normalized recent bodies (repeat kill)

        # --- Advisory soft turn-grant (floor control) -----------------------
        # CONNECTION-level state, NOT per-message: it answers "whose turn is it?"
        # so 3+ concurrent posters don't livelock the ?last= guard (first-waiter-
        # wins instead of fastest-poster-wins). Touched ONLY under self.lock; every
        # mutating op ends with cond.notify_all(). The relay NEVER blocks a send on
        # this -- it only REPORTS the holder/queue on the recv idle payload + send
        # reply. With RELAY_FLOOR_LEASE=0 these stay inert (holder None, queue empty)
        # and nothing populates the turn fields -> default-off byte-for-byte legacy.
        self.floor_holder: str | None = None  # token currently holding the floor (None = open)
        self.floor_since: float = 0.0  # time.monotonic() the current holder acquired (for the lease)
        self.floor_queue: list[str] = []  # FIFO of waiting tokens (no dupes); head is promoted on release/expiry

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

    def _display_topic(self) -> str:
        """The topic string to show in /trace's header and /peers' "topic" field.
        Prefer an explicit self.topic (RELAY_TOPIC env); when that is empty fall
        back to the FIRST line of the brief, so a --brief launch -- which sets
        self.brief but never self.topic -- still surfaces a topic everywhere a
        human or peer looks. "" only when there is neither a topic nor a brief."""
        if self.topic:
            return self.topic
        if self.brief:
            return self.brief.splitlines()[0]
        return ""

    # -- helpers (all called with self.lock held) --------------------------

    def _append(self, handle: str, body: str, sys: bool, extra: dict | None = None) -> dict:
        """Append one entry to the log and return it. Bumps the sequence.

        `extra` (optional) carries the per-message addressing fields the sender
        supplied AND that survived sanitizing -- a dict with any of `to`,
        `reply_to`, `kind`. ONLY present keys are merged onto the entry, so a
        system notice or a legacy raw/{"body":...} post (extra=None) stores the
        exact same keys as before -- _entry_view then omits any absent field."""
        entry = {
            "seq": len(self.log) + 1,
            "handle": handle,
            "body": body,
            "ts": time.time(),
            "sys": sys,
        }
        if extra:
            entry.update(extra)
        self.log.append(entry)
        return entry

    def _entry_view(self, e: dict, peer: dict) -> dict:
        """The single recv-facing projection of a log entry: the wire shape the
        client reads. Drops the internal `sys` flag and adds `is_me` (true iff
        this peer authored it). Sourced here so /recv, /send cross-detection, and
        the cursor-guard all serialize entries identically -- so every consumer
        (recv, both missed[] arrays, any future slice) inherits the same shape,
        including the OPTIONAL addressing fields below.

        ADDRESSING (all OPTIONAL, OMITTED WHEN ABSENT): on top of the base shape
        this attaches, only when present + non-empty:
          * `role`     -- the AUTHOR's current role, looked up live off the peer
                          record by handle (system entries + departed authors have
                          none, so the key is simply absent).
          * `to`       -- the message's recipient list (set at /send).
          * `reply_to` -- the seq this message replies to.
          * `kind`     -- the message's free-form kind tag.
        Absent fields are NOT emitted, so a legacy entry (raw body / {"body":...})
        serializes byte-identically to before the envelope existed. The relay only
        CARRIES these -- it never routes or validates on them."""
        view = {
            "seq": e["seq"],
            "handle": e["handle"],
            "body": e["body"],
            "ts": e["ts"],
            "is_me": e["handle"] == peer["handle"],
        }
        # AUTHOR role: looked up live off the peer record by handle (lock held).
        # Only the FIRST peer matching the handle is consulted -- handles are
        # unique among live peers. A system entry / a since-departed author has no
        # role, so the key stays absent.
        for p in self.peers.values():
            if p["handle"] == e["handle"] and p.get("role"):
                view["role"] = p["role"]
                break
        # Per-message envelope fields: present on the log entry ONLY when the
        # sender supplied a valid value (see send()), so the membership in `e`
        # gates emission -- absent stays absent.
        if e.get("to"):
            view["to"] = e["to"]
        if e.get("reply_to") is not None:
            view["reply_to"] = e["reply_to"]
        if e.get("kind"):
            view["kind"] = e["kind"]
        return view

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
            # PERSIST the full transcript exactly once, with the log complete and
            # the lock held. We render it through the SAME code path as /trace
            # (_render_history, the lock-free half of history()) so the file is
            # byte-identical to a /trace fetch -- topic header AND the closed line.
            # The path resolves like the other state files (_state_path), but UNLIKE
            # them the transcript MUST SURVIVE close: it is deliberately NOT added to
            # any cleanup site (_on_close / cleanup / bind-fail). We only ever write
            # it. The whole thing is wrapped so a write failure can never break
            # shutdown; the saved-path line lands in the .log so the host finds it.
            try:
                transcript_path = _state_path("transcript", ROOM)
                with open(transcript_path, "w", encoding="utf-8") as fh:
                    fh.write(self._render_history())
                print(f"transcript saved: {transcript_path}")
            except Exception as exc:  # never let a write failure block shutdown
                print(f"transcript save failed: {exc}")
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

    def join(self, role: str = "") -> tuple[str, str, int]:
        """Mint an opaque token + display handle for a new peer. The peer's
        cursor starts at the START of the log (0), so its FIRST /recv returns the
        whole conversation so far (the backlog) and only then does it block for
        new messages. This matters when the host posts ("hello, let's discuss X")
        and THEN hands over the jack URL: the late joiner must see that opener
        immediately, not sit blocked waiting for the next post. Subsequent scans
        advance the cursor as normal and return only new messages. Returns
        (token, handle, peer_count_before_this_join).

        OPTIONAL `role` (from /jack ?role=): an already-sanitized free-text label
        (newline-free, len-capped by the caller via _norm_label) stored on the
        peer record. "" == no role (today's behavior). It is surfaced in /peers'
        `roles` map and stamped onto this peer's entries via _entry_view, but the
        relay NEVER routes or validates on it -- pure carry."""
        with self.lock:
            peers_before = len(self.peers)
            # Mint a token unique among peers (3 bytes -> 6 hex chars).
            while True:
                token = secrets.token_hex(3)
                if token not in self.peers:
                    break
            self._handle_n += 1
            handle = f"peer-{self._handle_n}"
            # last_seen: monotonic stamp for the reaper. Set at join so a peer that
            # jacks in and immediately goes silent is still reaped from THIS moment.
            # last_send: monotonic stamp of this peer's last ACCEPTED post, for the
            # RELAY_MIN_SEND_INTERVAL rate gate. SEPARATE from last_seen on purpose
            # -- last_seen is refreshed by mere recv-polling, which must NOT reset
            # the send gate. Seeded to 0.0 (the monotonic epoch) so a peer's FIRST
            # post is never throttled (now - 0.0 is huge).
            self.peers[token] = {
                "handle": handle,
                "cursor": 0,
                "last_seen": time.monotonic(),
                "last_send": 0.0,
                # OPTIONAL addressing role (pre-sanitized). "" == absent; never
                # surfaced as a key when empty (see peers_list / _entry_view).
                "role": role,
            }
            self._any_joined = True
            # A (re)joining peer cancels any pending grace-period self-close: the
            # room is no longer empty, so the empty clock must reset. INVARIANT:
            # whenever >=1 peer is present, empty_since is None.
            self.empty_since = None
            # Presence: announce the join as a system event, mirroring leave's
            # "<handle> left" notice. Inside the lock, same as leave's _append.
            self._append("system", f"{handle} joined", sys=True)
            return token, handle, peers_before

    def leave(self, token: str, reason: str = "") -> bool:
        """A peer leaves. Posts a system '<handle> left' notice and drops the
        token. GRACE-PERIOD CLOSE: the conversation does NOT close the instant the
        LAST peer departs -- instead the empty clock (self.empty_since) starts, and
        the relay idles for up to EMPTY_GRACE seconds so a flaky client can
        reconnect (a (re)join inside the window cancels the close). If no one
        rejoins, the reaper self-closes the room once the grace elapses; an explicit
        /eject or the wall-clock cap still close it immediately. Returns False if
        the token is unknown."""
        with self.lock:
            peer = self.peers.pop(token, None)
            if peer is None:
                return False
            # A departing peer must not keep holding/queuing for the floor: drop it
            # under the SAME lock as the pop (promote the FIFO head if it was the
            # holder, else just dequeue it). The notify_all() below covers it.
            self._drop_floor(token)
            note = f"{peer['handle']} left"
            if reason:
                note += f" ({reason})"
            # Authored as "system" (like the closure notice) -- it's a relay
            # event, not a peer utterance. The body names the departing handle.
            self._append("system", note, sys=True)
            # GRACE-PERIOD CLOSE: if this was the LAST peer (room now empty and at
            # least one peer had ever joined), start the empty clock rather than
            # closing. The reaper self-closes once (now - empty_since) >= EMPTY_GRACE
            # unless someone (re)joins first (join() resets empty_since to None). The
            # _any_joined guard keeps a never-yet-joined room (host posted a topic,
            # hasn't handed out the jack URL) alive. (Was: self._close("all peers
            # left") here.)
            if not self.peers and self._any_joined:
                self.empty_since = time.monotonic()
            self.cond.notify_all()
            return True

    def reap_idle(self) -> int:
        """Drop every peer whose last_seen is older than PEER_TIMEOUT -- the
        presence reaper's one sweep. A peer is normally removed only by an explicit
        /unplug; this catches the agent that dies / drops its socket / stops polling
        and would otherwise linger forever. For each timed-out peer it appends the
        SAME system notice leave() posts -- '<handle> left (timed out)'. Returns how
        many peers it reaped.

        GRACE-PERIOD CLOSE: emptying the room (here or via leave()) does not close it
        immediately -- it starts/continues the empty clock (self.empty_since) so a
        flaky peer that timed out can still rejoin the SAME room within EMPTY_GRACE.
        Every sweep then checks the clock: once the room has stayed empty for >=
        EMPTY_GRACE secs (and at least one peer had ever joined), the room
        self-closes. A (re)join inside the window cancels it (join() clears
        empty_since). An explicit /eject or the wall-clock cap still close at once.

        LOCKING: mirrors leave() exactly -- acquire self.lock, mutate peers/log
        directly under it, and call _close() WHILE STILL HOLDING the lock (_close
        does not take the lock itself; it documents that callers hold it). The grace
        check + self.empty_since are likewise only touched under self.lock. No
        double-acquire, no unguarded mutation. Called only from the reaper thread."""
        now = time.monotonic()
        with self.lock:
            if self.closed:
                return 0  # already closing/closed; nothing to reap
            # Lazy floor-lease reclaim, once per sweep -- same lock, no new thread.
            # A hung holder that never /releases is auto-advanced here even if no
            # send/recv is active to trigger the other two call sites.
            self._reclaim_floor_if_stale()
            dead = [tok for tok, p in self.peers.items() if now - p["last_seen"] > PEER_TIMEOUT]
            for tok in dead:
                peer = self.peers.pop(tok)
                # A dead peer must not keep "holding the floor" -- drop it from
                # holder+queue IN THE SAME critical section as the pop (promote the
                # FIFO head if it WAS the holder). This is what lets a queued waiter
                # become holder the instant the silent holder is reaped.
                self._drop_floor(tok)
                # Same envelope as leave()'s '<handle> left' notice, tagged so a
                # watcher can tell a timeout from a civil unplug.
                self._append("system", f"{peer['handle']} left (timed out)", sys=True)
            # GRACE-PERIOD CLOSE (start the clock): if reaping just emptied the room
            # (and someone had ever joined) and the empty clock isn't already running
            # -- e.g. the last peer was reaped here rather than via leave() -- start
            # it now. The _any_joined guard keeps a never-yet-joined room alive.
            if not self.peers and self._any_joined and self.empty_since is None:
                self.empty_since = now
            if dead:
                # Wake any parked /recv so reaped-peer '<handle> left (timed out)'
                # notices drain promptly.
                self.cond.notify_all()
            # GRACE-PERIOD CLOSE (expiry check, every sweep, lock held): once the room
            # has stayed empty for >= EMPTY_GRACE secs with no (re)join, self-close.
            # A (re)join inside the window cleared empty_since back to None, so this
            # never fires while a peer is present. _close() is called WHILE HOLDING
            # self.lock (it does not re-acquire). With EMPTY_GRACE=0 an empty room
            # closes on the very next sweep.
            if (
                not self.peers
                and self._any_joined
                and self.empty_since is not None
                and (now - self.empty_since) >= EMPTY_GRACE
            ):
                self._close(f"room empty {EMPTY_GRACE}s")
            return len(dead)

    # -- floor control (advisory soft turn-grant) --------------------------
    # ALL of the following run with self.lock HELD (the same contract _close
    # documents): callers acquire the lock, then call these directly. None of them
    # re-acquires the lock (that would deadlock). The MUTATING ones
    # (_floor_op acquire/release, _reclaim_floor_if_stale, _drop_floor) end the
    # mutation by leaving cond.notify_all() to their caller's flow -- _floor_op and
    # the reaper notify after; _reclaim_floor_if_stale notifies itself because it is
    # also invoked from read-side paths (recv/send) that may not otherwise notify.

    def _floor_handle(self, token: str | None) -> str | None:
        """Map a floor token to its display handle for the JSON reply, or None if
        the token is unset / no longer a live peer. Lock held."""
        if token is None:
            return None
        peer = self.peers.get(token)
        return peer["handle"] if peer else None

    def _drop_floor(self, token: str) -> None:
        """Remove `token` from the floor entirely -- used when a peer leaves or is
        reaped. If it was the HOLDER, promote the FIFO queue head as the new holder
        (resetting the lease clock) else clear the floor; if it was only queued,
        just drop it from the queue. Lock held; does NOT notify (the caller --
        leave()/reap_idle() -- already notifies in the same critical section)."""
        if token in self.floor_queue:
            self.floor_queue.remove(token)
        if self.floor_holder == token:
            self.floor_holder = self.floor_queue.pop(0) if self.floor_queue else None
            self.floor_since = time.monotonic()

    def _reclaim_floor_if_stale(self) -> None:
        """LAZY lease expiry (no thread). When RELAY_FLOOR_LEASE > 0 and the current
        holder has held longer than the lease, the floor auto-advances: promote the
        FIFO queue head as the new holder (reset the lease clock) or clear it if the
        queue is empty. This is the anti-livelock backstop -- a holder that hangs or
        dies without releasing cannot pin the floor forever, and a waiting peer is
        GUARANTEED its turn on the lease clock alone. Lock held. Called from the top
        of send(), inside recv()'s wait loop (before building the idle payload), and
        once per reap_idle() sweep. NO-OP when the feature is off (lease <= 0) or no
        one holds the floor -> default-off changes nothing. Notifies on an actual
        advance so a parked recv re-renders the new holder promptly."""
        if FLOOR_LEASE <= 0 or self.floor_holder is None:
            return
        if time.monotonic() - self.floor_since <= FLOOR_LEASE:
            return
        # Lease lapsed -> advance to the next waiter (or clear) and reset the clock.
        self.floor_holder = self.floor_queue.pop(0) if self.floor_queue else None
        self.floor_since = time.monotonic()
        self.cond.notify_all()

    def _floor_fields(self, token: str) -> dict:
        """The additive TURN FIELDS for the recv idle payload + the send 200 reply,
        from the perspective of the peer `token`. Lock held. Always returns the
        three keys (additive -- legacy peers / fake_agent just ignore them):
          * floor_holder  -- the holder's handle, or null (open / no live holder).
          * floor_is_mine -- True iff this caller currently holds the floor.
          * floor_wait    -- how many queued tokens sit AHEAD of this caller (0 if
                             the caller is the holder, is open, or is at the head).
        With the feature OFF (lease <= 0) nothing ever acquires the floor, so this
        is {holder:null, is_mine:false, wait:0} -- inert, as if absent."""
        is_mine = self.floor_holder == token
        wait = self.floor_queue.index(token) if token in self.floor_queue else 0
        return {
            "floor_holder": self._floor_handle(self.floor_holder),
            "floor_is_mine": is_mine,
            "floor_wait": wait,
        }

    def _floor_op(self, token: str, op: str) -> tuple[int, dict]:
        """GET /floor?op=acquire|release|status -- the advisory turn-grant primitive.
        Validates the token (401 if unknown), then under the lock:
          * acquire -> if the floor is OPEN, grant it (holder=you, floor_since=now);
                       else append you to the FIFO queue idempotently (no dupes) and
                       report your position. Already-holder/already-queued is a no-op
                       that just reports your current standing.
          * release -> if you ARE the holder, promote the FIFO head as the new holder
                       (reset the lease clock) or clear the floor; if you are only
                       queued, drop you from the queue; if you hold nothing, no-op.
          * status  -> read-only snapshot (no mutation, no notify).
        Returns (200, {ok, floor_holder:<handle|null>, is_mine:<bool>,
        queue:[<handles>], position:<int|null>}). position is the caller's 1-based
        RANK in the queue -- head is 1 (None if not queued / is the holder). Every
        MUTATING op
        ends with cond.notify_all() so a parked recv re-renders the turn fields at
        once. The relay NEVER blocks a send on any of this -- it only records turns.

        A stale lease is reclaimed at the TOP (so an acquire can grab a floor whose
        holder's lease just lapsed). With RELAY_FLOOR_LEASE=0 the op still works --
        acquire/release/status all mutate/read the same state -- but nothing ever
        expires, matching the documented default-off behavior (status returns
        holder:null on a fresh relay until someone acquires)."""
        with self.lock:
            peer = self.peers.get(token)
            if peer is None:
                return 401, {"ok": False, "error": "unknown token (did you /jack?)"}
            # Contact -> refresh presence so a peer driving the floor isn't reaped.
            peer["last_seen"] = time.monotonic()
            # Reclaim a lapsed lease first so acquire can take a just-expired floor.
            self._reclaim_floor_if_stale()

            mutated = False
            if op == "acquire":
                if self.floor_holder is None:
                    self.floor_holder = token
                    self.floor_since = time.monotonic()
                    if token in self.floor_queue:  # belt-and-suspenders de-dupe
                        self.floor_queue.remove(token)
                elif self.floor_holder != token and token not in self.floor_queue:
                    self.floor_queue.append(token)  # FIFO, idempotent (no dupes)
                mutated = True
            elif op == "release":
                if self.floor_holder == token:
                    self.floor_holder = self.floor_queue.pop(0) if self.floor_queue else None
                    self.floor_since = time.monotonic()
                    mutated = True
                elif token in self.floor_queue:
                    self.floor_queue.remove(token)
                    mutated = True
                # holder of nothing + not queued -> civil no-op
            elif op != "status":
                return 400, {"ok": False, "error": f"unknown op {op!r} (acquire|release|status)"}

            if mutated:
                # Mirror send/leave/reap: every mutation wakes parked recvs so the
                # turn fields they render are never stale by more than a lock hop.
                self.cond.notify_all()

            # position: 1-based RANK among waiters (queue head is #1), or None when
            # the caller is the holder / not queued. Distinct from floor_wait (the
            # COUNT ahead of the caller): waiter #1's position is 1 but its wait is 0.
            position = self.floor_queue.index(token) + 1 if token in self.floor_queue else None
            return 200, {
                "ok": True,
                "floor_holder": self._floor_handle(self.floor_holder),
                "is_mine": self.floor_holder == token,
                "queue": [self._floor_handle(t) for t in self.floor_queue],
                "position": position,
            }

    # -- send (append) -----------------------------------------------------

    def send(
        self,
        token: str,
        body: str,
        last: int | None = None,
        to: object = None,
        reply_to: object = None,
        kind: object = None,
    ) -> tuple[int, dict]:
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
        cursor; it trusts only the seq the caller passes.

        OPTIONAL ADDRESSING ENVELOPE: `to` / `reply_to` / `kind` are the RAW values
        the sender supplied (from a {"body",...} JSON send); each is sanitized here
        and, ONLY if it survives non-empty, attached to the entry + echoed:
          * `to`       -> _norm_to() -> list[str] (bare str coerced to 1 elem, items
                          newline-stripped + len-capped, list capped TO_MAX_ITEMS).
          * `reply_to` -> int >= 1 or dropped.
          * `kind`     -> stripped, newline-free, len-cap KIND_MAX. FREE-FORM -- the
                          relay does NOT validate it against any enum (floor-control
                          rides `kind` next stage). Carry only.
        Absent/invalid fields are simply not stored, so a raw or {"body":...} legacy
        send produces an entry with NONE of these keys (byte-identical to before).
        The envelope NEVER affects the caps: the repetition kill is BODY-ONLY (see
        _norm), so two identical bodies addressed differently still trip the stall."""
        with self.lock:
            peer = self.peers.get(token)
            if peer is None:
                return 401, {"ok": False, "error": "unknown token (did you /jack?)"}
            # Authenticated action -> refresh presence so the reaper won't drop us.
            peer["last_seen"] = time.monotonic()
            if self.closed:
                return 409, {"ok": False, "error": f"conversation closed: {self.close_reason}"}

            # ADVISORY FLOOR -- lazy lease reclaim, NOT a gate. A send is NEVER
            # refused on floor state; we only fold the freshest turn info into the
            # 200 reply below. Reclaiming here (under the lock) means a holder whose
            # lease just lapsed is auto-advanced even between reaper sweeps, so the
            # floor_holder a sender sees is current. No-op when the feature is off.
            self._reclaim_floor_if_stale()

            # PER-PEER RATE GATE (RELAY_MIN_SEND_INTERVAL). Independent of the
            # repetition kill (identical-consecutive bodies) and the turn cap
            # (total volume): this bounds how FAST one peer may post, whatever the
            # content. We compare against THIS peer's last ACCEPTED post (last_send,
            # not last_seen -- recv-polling must not reset the gate). On a violation
            # we 429 (too many requests) and do NOT append. We do NOT
            # stamp last_send here: a hammering peer must not push its own window
            # forward, or it could never escape the gate. last_send is stamped ONLY
            # on the accepted path below. Disabled when MIN_SEND_INTERVAL <= 0.
            if MIN_SEND_INTERVAL > 0:
                since = time.monotonic() - peer["last_send"]
                if since < MIN_SEND_INTERVAL:
                    retry_after = round(MIN_SEND_INTERVAL - since)
                    return 429, {
                        "ok": False,
                        "error": "rate limited",
                        "retry_after": retry_after,
                        "min_interval": MIN_SEND_INTERVAL,
                    }

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
                    self._entry_view(e, peer) for e in self.log if e["seq"] > last and e["handle"] != peer["handle"]
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

            # Sanitize the OPTIONAL addressing envelope into `extra` -- ONLY
            # present + valid fields land. This runs AFTER the repetition kill
            # computed `n` from the body alone, so the envelope can never influence
            # the stall guard (it stays BODY-ONLY). Each field is independent: a bad
            # `to` doesn't suppress a good `kind`.
            extra: dict = {}
            norm_to = _norm_to(to)
            if norm_to:
                extra["to"] = norm_to
            if reply_to is not None:
                with contextlib.suppress(ValueError, TypeError):
                    rt = int(reply_to)
                    if rt >= 1:
                        extra["reply_to"] = rt
            norm_kind = _norm_label(kind, KIND_MAX)
            if norm_kind:
                extra["kind"] = norm_kind

            entry = self._append(peer["handle"], body, sys=False, extra=extra)
            self.turns += 1
            # ACCEPTED path -> advance this peer's rate-gate window. Stamped ONLY
            # here (never on a throttled 429 above) so a hammering peer can't push
            # its own window forward and starve itself out of the gate forever.
            peer["last_send"] = time.monotonic()

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
            missed = [self._entry_view(e, peer) for e in self.log if e["seq"] > cur and e["handle"] != peer["handle"]]
            reply = {
                "ok": True,
                "seq": entry["seq"],
                "handle": peer["handle"],
                "crossed": bool(missed),
                "missed": missed,
            }
            # ADDITIVE: same semantics as the recv idle heartbeat -- have all OTHER
            # current peers already read this peer's latest post (the one just
            # appended)? Cheap (O(log tail + peers)) and we already hold the lock
            # here, so the sender learns its just-sent message's read state without
            # a follow-up recv. A legacy peer simply ignores the extra key.
            reply["caught_up"] = self._caught_up(peer)
            # Echo back ONLY the envelope fields that were accepted onto the entry,
            # so the sender sees exactly what the relay stored (and absent stays
            # absent in the reply too). `extra` already holds just present+valid.
            reply.update(extra)
            # ADDITIVE turn fields (floor_holder / floor_is_mine / floor_wait): tell
            # the sender whose turn it is right now, so it can pair ?last= (reactive
            # collision backstop) with the floor (proactive "is it my turn"). With
            # the feature off these are {null,false,0} -- inert, ignored by legacy
            # peers + fake_agent. The floor NEVER blocked this send; it only reports.
            reply.update(self._floor_fields(token))
            return 200, reply

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

    def _visible_to(self, e: dict, peer: dict) -> bool:
        """The advisory ?mine= filter predicate. An entry is shown to a filtering
        caller iff it is a SYSTEM entry (joins/leaves/closed are NEVER filtered),
        OR it is broadcast (no/empty `to`), OR its `to` contains the caller's
        handle. Reuses _norm_to for the membership test so "addressed to me" means
        exactly what was stored. The caller's OWN posts are addressed-or-broadcast
        like anyone's; is_me on the entry still lets the client skip them."""
        if e.get("sys"):
            return True  # system notices always pass the filter
        to = _norm_to(e.get("to"))
        if not to:
            return True  # broadcast (no recipients) -> everyone sees it
        return peer["handle"] in to

    def slice_since(self, peer: dict, after_seq: int, limit: int | None) -> tuple[list[dict], int]:
        """A cursor-SAFE historical slice for ?since=<seq>: the recv-shaped entries
        with seq STRICTLY GREATER THAN `after_seq`, capped to the first `limit` if
        given (None = no cap). Returns (entries, total_beyond_after) where the
        second value is how many raw entries lie past `after_seq` REGARDLESS of the
        cap -- so a caller can tell whether the slice was clipped.

        Reuses _entry_view, so the slice inherits the exact recv wire shape (is_me +
        the optional role/to/reply_to/kind envelope). It is a FULL historical slice:
        the ?mine filter is deliberately NOT applied here -- ?since is a resync/peek
        tool, so it always returns the real log.

        CRITICAL: this NEVER touches peer["cursor"]. It is a read-only peek that
        leaves the server-held read position exactly where it was -- so a ?since
        request can never make the caller's normal recv loop skip the backlog. The
        caller (the /recv handler) returns this synchronously, with no long-poll."""
        with self.lock:
            beyond = [e for e in self.log if e["seq"] > after_seq]
            window = beyond[:limit] if limit is not None else beyond
            return [self._entry_view(e, peer) for e in window], len(beyond)

    def recv_since(self, token: str, after_seq: int) -> tuple[int, object]:
        """The ?since=<seq> read path: a SYNCHRONOUS, cursor-SAFE historical slice.
        Validates the token (401 if unknown), refreshes presence (so a peer that
        only ever resyncs isn't reaped), and returns (200, [entries with seq >
        after_seq]). It NEVER long-polls and NEVER advances peer["cursor"]: the
        normal recv loop's read position is untouched, so a ?since is a pure peek.

        It is a FULL historical slice -- the ?mine filter does NOT apply (resync
        sees the real log). `after_seq` past the tip yields [] (200). POST-CLOSE it
        STILL works: the in-log 'conversation closed' system entry is just another
        entry, so it is returned INSIDE the array -- ?since never emits the terminal
        {"system": ...} stop-object that a normal recv uses, because a ?since reply
        is HISTORICAL (a resync), not a 'keep going' signal."""
        with self.lock:
            peer = self.peers.get(token)
            if peer is None:
                return 401, {"ok": False, "error": "unknown token (did you /jack?)"}
            # Resync still counts as contact -> refresh presence (mirrors recv's
            # arrival refresh) so a peer that only ?since-peeks isn't reaped.
            peer["last_seen"] = time.monotonic()
        # slice_since takes the lock itself; it is read-only and never touches the
        # cursor. No long-poll, no close branch -- the closed notice (if any) rides
        # the slice as an ordinary entry.
        entries, _total = self.slice_since(peer, after_seq, None)
        return 200, entries

    def recv(self, token: str, wait: float, mine: bool = False, exclude_me: bool = False) -> tuple[int, object]:
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
          * (200, {"entries": [...], "truncated": True, "remaining": R,
                   "next_since": S, "hint": "..."})
                                 -- ONLY when RELAY_MAX_REPLAY > 0 and the unread
                                    backlog exceeded it: a WINDOWED batch. `entries`
                                    is the first N (filtered by ?mine if set);
                                    `remaining` how many raw entries are still past
                                    the cursor; `next_since` the last DELIVERED raw
                                    seq; `hint` names both ways to resume (re-run
                                    recv, or ?since=next_since). The client just
                                    re-runs recv to drain the next window.

        The closed case never blocks and never returns the idle heartbeat: once
        closed, /recv returns the closed payload immediately so no waiter can hang
        and no client is tricked into re-polling a dead conversation. This is the
        deadlock fix.

        This is the heart of the "peer side stays trivial" promise: the server
        holds the connection open and holds the cursor, so the agent just
        re-runs the same `recv` curl each turn -- no bash loop, no cursor math.

        OPTIONAL ?mine= FILTER (`mine=True`): show only entries RELEVANT to this
        caller -- broadcasts (no `to`) + messages whose `to` names this handle +
        ALL system entries (joins/leaves/closed are never filtered). CRUCIAL
        invariant: the cursor STILL advances past EVERYTHING the raw log holds; the
        filter changes only WHAT IS SHOWN this call, never the read position. So an
        others-addressed message the filter hides is NOT re-delivered next call
        (the cursor moved past it) -- and caught_up / close detection, which key off
        the cursor, keep working. If the filter empties a batch (every new entry was
        for someone else), we DON'T return an empty list; we advance the cursor and
        loop, so the caller gets a proper idle heartbeat (or the closed signal),
        never a confusing []. mine=False (default) delivers the full group log,
        completely unchanged.

        BACKLOG WINDOWING (RELAY_MAX_REPLAY > 0): an unread slice longer than N raw
        entries is delivered N at a time. The cursor advances to JUST the window's
        last seq (not the tip), so the next plain recv resumes there -- the loop
        self-heals, draining the backlog window by window with no gap and no dup,
        and returns the truncation OBJECT above so the caller knows more is waiting.
        Composes with ?mine the same way the unwindowed path does: we cap the RAW
        slice to N and move the cursor over the WHOLE window FIRST, THEN filter for
        what's shown -- so a hidden others-addressed entry inside the window is
        skipped, never re-queued. With the knob at its default 0 a recv is the BARE
        ARRAY above (no object, no truncated flag) -- byte-identical to before.
        """
        deadline = time.time() + wait
        with self.lock:
            peer = self.peers.get(token)
            if peer is None:
                return 401, {"ok": False, "error": "unknown token (did you /jack?)"}
            # Refresh presence on REQUEST ARRIVAL (not on return): a peer about to
            # park in a long-poll has just contacted us, so it counts as just-seen
            # -- this is what keeps a healthy looping agent (re-issuing /recv every
            # ~IDLE_WAIT) safely under PEER_TIMEOUT and never reaped.
            peer["last_seen"] = time.monotonic()

            while True:
                # Anything in the log past our cursor? (covers normal posts AND
                # the system closure notice, so a closing conversation drains.)
                # The check + the cursor advance use the RAW log slice REGARDLESS of
                # the ?mine filter -- the cursor must move past everything so the
                # filter never causes a re-poll loop and close detection still works.
                if len(self.log) > peer["cursor"]:
                    raw = self.log[peer["cursor"] :]
                    # BACKLOG WINDOWING (RELAY_MAX_REPLAY): when the knob is on and
                    # this raw slice is over the cap, deliver only the first N raw
                    # entries and advance the cursor to JUST that window's last seq
                    # (NOT the log tip) -- so the rest stays unread and the NEXT
                    # plain recv resumes exactly here, draining the backlog in
                    # N-sized windows with no gap and no dup. We compute this on the
                    # RAW slice BEFORE the ?mine filter so the cursor moves over
                    # everything in the window regardless of what's shown (the same
                    # invariant the unwindowed path keeps). When the knob is off
                    # (MAX_REPLAY <= 0) or the slice fits, window IS the whole raw
                    # slice and truncated stays False -> the BARE-ARRAY path below,
                    # byte-identical to before this feature.
                    truncated = MAX_REPLAY > 0 and len(raw) > MAX_REPLAY
                    window = raw[:MAX_REPLAY] if truncated else raw
                    peer["cursor"] = window[-1]["seq"]  # advance over the DELIVERED window only
                    # THEN apply the advisory filters to the windowed entries --
                    # they narrow only WHAT IS SHOWN, never the cursor (already
                    # moved). An entry shows iff it passes the ?mine filter (when
                    # set) AND, when ?exclude_me is set, it was NOT authored by this
                    # peer. Both compose as an intersection. SYSTEM notices
                    # (join/leave/closed) ALWAYS pass exclude_me -- the same carve-out
                    # ?mine uses (see _visible_to / _entry_view's sys check) -- so a
                    # peer that hides its own chatter still sees the closed notice.
                    shown = [
                        e
                        for e in window
                        if (not mine or self._visible_to(e, peer))
                        and (not exclude_me or e.get("sys") or e["handle"] != peer["handle"])
                    ]
                    out = [self._entry_view(e, peer) for e in shown]
                    if truncated:
                        # WINDOWED batch -> return the truncation OBJECT (never []):
                        # even if the ?mine filter emptied `out`, the caller must
                        # learn the backlog was clipped and how to resume. next_since
                        # = the last DELIVERED raw seq (continuity handle); remaining
                        # = raw entries still past the new cursor; hint names BOTH
                        # escape hatches. The cursor already advanced over the whole
                        # window, so a plain re-run-recv self-heals identically.
                        next_since = window[-1]["seq"]
                        return 200, {
                            "entries": out,
                            "truncated": True,
                            "remaining": len(raw) - len(window),
                            "next_since": next_since,
                            "hint": (
                                f"backlog windowed to {MAX_REPLAY}; "
                                f"{len(raw) - len(window)} more waiting -- just re-run recv to drain the next "
                                f"batch, or fetch them now with ?since={next_since}"
                            ),
                        }
                    if out:
                        return 200, out
                    # Filter emptied this batch (all others-addressed). Cursor has
                    # ALREADY advanced; loop so the caller gets idle/closed, not [].
                    continue

                # Nothing new past the cursor. If CLOSED, there will never be
                # anything new -> return the explicit terminal signal IMMEDIATELY
                # (no wait, no 204). A freshly-arriving recv on an already-closed
                # conversation hits this on the first loop iteration; a parked
                # recv hits it the instant _close()'s notify_all wakes it. Either
                # way the client gets a clear "closed" and stops.
                if self.closed:
                    return 200, {"system": f"conversation closed: {self.close_reason}"}

                # ADVISORY FLOOR -- lazy lease reclaim BEFORE we build the idle
                # heartbeat, so a quiet peer's heartbeat always reports the CURRENT
                # holder: a holder whose lease lapsed while everyone was parked is
                # auto-advanced here (under the lock), and the queued waiter that
                # gets promoted sees floor_is_mine flip true on its very next idle
                # beat -- the lease clock alone hands it the turn, no /release. The
                # reclaim notify_all() (on an actual advance) also re-wakes the other
                # parked recvs so they re-render. No-op when the feature is off.
                self._reclaim_floor_if_stale()

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
                    # learns the relay is alive + quiet and just re-runs recv. The
                    # ADDITIVE turn fields (floor_holder / floor_is_mine /
                    # floor_wait) ride along -- a quiet peer learns whose turn it is
                    # without sending. With the feature off they are {null,false,0}.
                    idle = {
                        "idle": True,
                        "cursor": peer["cursor"],
                        "peers": len(self.peers),
                        "caught_up": self._caught_up(peer),
                        "peers_list": sorted(p["handle"] for p in self.peers.values()),
                        "is_last_peer": len(self.peers) == 1,
                    }
                    idle.update(self._floor_fields(token))
                    return 200, idle
                self.cond.wait(timeout=remaining)

    # -- trace -------------------------------------------------------------

    def _trace_suffix(self, e: dict) -> str:
        """A compact human-readable addressing tail for a /trace line, built from
        the entry's OPTIONAL envelope fields. Renders only the present ones:
        ` ->a,b` (to), ` re#N` (reply_to), ` [kind]` (kind). A plain entry with no
        envelope yields "" -- the trace line is byte-identical to before."""
        bits = []
        if e.get("to"):
            bits.append(" ->" + ",".join(e["to"]))
        if e.get("reply_to") is not None:
            bits.append(f" re#{e['reply_to']}")
        if e.get("kind"):
            bits.append(f" [{e['kind']}]")
        return "".join(bits)

    def history(self) -> str:
        """Render the full ordered log as human-readable plain text. A message's
        OPTIONAL addressing envelope (to/reply_to/kind) shows as a compact suffix
        (see _trace_suffix); plain messages render exactly as before."""
        with self.lock:
            return self._render_history()

    def _render_history(self) -> str:
        """The actual /trace renderer, with NO locking -- callers must already hold
        self.lock. Split out of history() so the close funnel (which runs under the
        lock) can persist a transcript that is BYTE-IDENTICAL to /trace without
        re-acquiring the non-reentrant lock. history() is the locked public entry."""
        topic = self._display_topic()
        head = "=== wire conversation" + (f" -- topic: {topic}" if topic else "") + " ==="
        lines = [head]
        for e in self.log:
            stamp = time.strftime("%H:%M:%S", time.localtime(e["ts"]))
            tag = "**" if e["sys"] else "  "
            lines.append(f"[{stamp}] {tag}{e['handle']}: {e['body']}{self._trace_suffix(e)}")
        if self.closed:
            lines.append(f"--- closed: {self.close_reason} ---")
        return "\n".join(lines) + "\n"

    # -- peers -------------------------------------------------------------

    def peers_list(self) -> dict:
        """Who's currently connected, plus conversation status.

        `peers` (sorted handles) and `count` are UNCHANGED -- the same shape every
        existing reader relies on. The OPTIONAL `roles` map is purely additive: it
        carries {handle: role} for ONLY the peers that jacked with a ?role=, so a
        room where nobody set a role yields an empty map and legacy callers ignore
        the new key. Advisory display only -- the relay never routes on it."""
        with self.lock:
            return {
                "peers": sorted(p["handle"] for p in self.peers.values()),
                "count": len(self.peers),
                # roles: handle -> role, only for peers that supplied one. Empty
                # {} when no peer set a role -> fully back-compatible.
                "roles": {p["handle"]: p["role"] for p in self.peers.values() if p.get("role")},
                "closed": self.closed,
                "close_reason": self.close_reason,
                "turns": self.turns,
                "topic": self._display_topic(),
            }


# The ONE conversation for this process. Topic comes from RELAY_TOPIC if set;
# the topic brief from RELAY_BRIEF (a --brief argv value overrides it in main()).
CONVO = Conversation(os.environ.get("RELAY_TOPIC", ""), os.environ.get("RELAY_BRIEF", ""))


# ===========================================================================
# The personalized MANUAL. This text IS the product's UX: it's the only thing
# a fresh agent needs to participate. Curl commands come pre-filled with token.
# ===========================================================================
def build_manual(
    convo: Conversation, token: str, handle: str, peers_before: int, base: str, secret: str, role: str = ""
) -> str:
    # `base` is the already-resolved {scheme}://{authority} (see Handler._advertised):
    # the RELAY_PUBLIC_BASE override, else derived from the request's Host /
    # X-Forwarded-Proto, else the configured host:port. Every {base}-templated
    # command below (recv/send/unplug/floor/trace/peers) inherits it.
    peer_word = "peer" if peers_before == 1 else "peers"
    # OPTIONAL role greeting: when this peer jacked with a ?role=, name it back so
    # the agent sees the label it was given. "" (no role) -> the greeting is byte-
    # identical to before.
    role_phrase = f" (role: {role})" if role else ""
    topic_line = f"Topic: {convo.topic}\n" if convo.topic else ""
    # When a brief was seeded, surface it as a TOPIC block up top -- a remote
    # peer reads this manual BEFORE its first /recv, so the topic must be visible
    # here too (the full brief also rides the log as the seq-1 system entry). The
    # brief is rendered verbatim, multiline and all.
    topic_block = f"TOPIC -- what this discussion is about:\n{convo.brief}\n\n" if convo.brief else ""
    return f"""\
You are {handle}{role_phrase}. {peers_before} {peer_word} currently here.
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

  recv:    curl -s --max-time 35 "{base}/recv?t={token}&k={secret}"
  send:    curl -s -X POST "{base}/send?t={token}&k={secret}" --data-binary @- <<'WIRE'
YOUR MESSAGE HERE
WIRE
  unplug:  curl -s "{base}/unplug?t={token}&k={secret}"

QUICKSTART (you can start now; the rest is reference):
  * Run recv to listen. Just re-run it -- a ~25s {{"idle": true}} heartbeat is
    normal; run it again.
  * Run send only when you ADD something.
  * Skip any entry where "is_me" is true -- that's your own echo.
  * HTTP 409 "behind" = someone posted first -> recv, reconsider, then send. If
    their post already made your point, DON'T re-send.
  * A {{"system": "conversation closed"}} object OR a connection error = STOP,
    never retry.
  * Run unplug when the task's done.
  Everything below is reference -- skim once; a short chat won't need most of it.

The send uses a heredoc (<<'WIRE' ... WIRE) so apostrophes and quotes in your
message ("don't", "it's", "can't") pass through verbatim -- no escaping, nothing
to break. Put your text between the two WIRE markers. (The server also accepts a
JSON body {{"body": "..."}} if you'd rather build the request that way.)

Two send guardrails the relay may enforce (both reject WITHOUT posting, so just
adjust and retry -- they are not the conversation closing):
  * Body size: an over-large body gets HTTP 413
    {{"ok": false, "error": "body too large", "max_bytes": <N>}}. Send less --
    split a long message into smaller posts under max_bytes.
  * Send rate: posting again too soon gets HTTP 429
    {{"ok": false, "error": "rate limited", "retry_after": <secs>, "min_interval": <s>}}.
    Wait retry_after seconds, then send. (recv as usual meanwhile -- only sending
    is throttled.)

HOW TO PARTICIPATE (this is your job until the task is done):
  Run recv. Your FIRST recv returns the conversation SO FAR (everything posted
  before you joined) as a JSON array -- read it to catch up. After that, just
  KEEP RE-RUNNING recv: it returns within ~25s either with new messages OR with a
  small idle heartbeat (see below) -- it does NOT block until someone posts. If
  you have something to add, run send, then run recv again. Repeat. That
  re-running of recv is the entire loop -- no script needed, and nothing to
  append: just run the recv command exactly as printed.

  (When nothing new has arrived, recv returns within ~25s a 200 idle HEARTBEAT --
  a JSON object {{"idle": true, "cursor": N, "peers": M, "caught_up": <bool>}} --
  so a quiet line never looks like a dropped connection. That is normal and
  EXPECTED: just run the SAME recv command again. The server answers on its own
  ~25s clock, comfortably inside the command's --max-time, so you never need to
  add or lower a wait yourself. caught_up tells you whether everyone else has read
  your latest post yet -- use it to gauge whether the group has seen what you last
  said before you decide to post again.)

  Note: recv returns ALL new messages including your OWN posts, echoed back.
  Each entry carries an "is_me" flag -- skip the entries where "is_me" is true
  and respond only to others'.

  send's reply also reports crossings: {{"ok": true, "seq": S, "handle": H,
  "crossed": <bool>, "missed": [ ...entries... ], "caught_up": <bool>}}. This is
  the REACTIVE signal -- you have ALREADY posted: `crossed` true means someone
  posted while you were typing and `missed` lists those posts. `missed` is safe to
  read and act on directly; every entry in it is also redelivered on your next
  recv, so you lose nothing either way. `caught_up` tells you whether all other
  current peers have now read the message you just posted -- so you learn if your
  point landed WITHOUT a separate recv. Note this value is measured at SEND time,
  so for the message you just posted it is normally false (nobody has read it yet)
  -- watch your NEXT recv idle heartbeat for caught_up to flip true.

  To PREVENT talking over others instead of just noticing after the fact, add
  ?last=<highest seq you've seen> to send (heredoc keeps apostrophes safe):
    curl -s -X POST "{base}/send?t={token}&k={secret}&last=<seq>" --data-binary @- <<'WIRE'
YOUR MESSAGE HERE
WIRE
  If anyone has posted past that seq, send is REFUSED with HTTP 409
  {{"ok": false, "error": "behind", "latest": <seq>, "missed": [ ...entries... ]}}
  and your message is NOT posted. To RECOVER from a 409:
    1. run recv once to read the missed posts (they're listed in `missed` too,
       same shape as recv entries);
    2. re-send -- either with ?last=<the new "latest" seq> if your point still
       stands, or with NO ?last= at all to post unguarded once you've caught up.
  But FIRST check the missed posts: if one of them already made your point, DROP
  yours -- do not re-send a duplicate (you only post when you ADD something).
  Do NOT immediately retry the SAME guarded send in a tight loop: under several
  active posters someone may post again between your recv and your retry, 409'ing
  you once more -- recv first, reconsider, then send. (Dropping ?last= after you
  have read the missed posts always lets the send through.)

TURN-TAKING (optional floor control -- ADVISORY, the relay never blocks a send):
  Under 3+ active posters, repeatedly losing the ?last= race (always a step behind,
  always 409) is a livelock. To take turns FAIRLY, ask for the floor FIRST -- it is
  first-waiter-wins, so even a slow peer is guaranteed a turn:
    acquire: curl -s "{base}/floor?t={token}&k={secret}&op=acquire"
    release: curl -s "{base}/floor?t={token}&k={secret}&op=release"
    status:  curl -s "{base}/floor?t={token}&k={secret}&op=status"
  Each returns {{"ok": true, "floor_holder": <handle|null>, "is_mine": <bool>,
  "queue": [<handles>], "position": <int|null>}}. acquire grants the floor if it is
  open ("is_mine": true) else puts you in the FIFO queue ("position": your spot in
  line, 1 = next up). When you are done, release -- the next waiter is promoted.
  This is the PROACTIVE "is it my turn?" line; ?last= above stays the REACTIVE
  backstop for the collisions that still slip through. The floor is ADVISORY: the
  relay never refuses a /send because someone else holds it -- it only REPORTS the
  holder. Your recv idle heartbeat and every send reply carry the same picture:
  "floor_holder" (whose turn), "floor_is_mine" (is it yours), "floor_wait" (how many
  are ahead of you). A held floor that goes silent is auto-released after a lease, so
  the turn never gets stuck. If your host did not enable the lease, "floor_holder" is
  null everywhere and you can ignore all of this -- just use ?last= as above.

  If recv ever returns a conversation-closed system message (a JSON object with
  a `system` field, e.g. {{"system": "conversation closed: ..."}}), the
  conversation is OVER. STOP. Do not run recv or send again. Likewise, once the
  line has been live, a connection or transport error (connection refused, could
  not connect, empty reply) means the relay process is GONE -- the room closed
  and exited. Treat it the same as the closed signal: STOP, do not retry.

ADDRESSING (all OPTIONAL -- omit any of it and the line behaves exactly as above):
  You may tag who a message is for and what it is, and filter what you read. All
  of this is ADVISORY: the relay carries + echoes these fields and offers the
  recv filter, but it does NOT enforce routing -- every peer can still read the
  whole log via a plain recv. Use it to keep a busy room legible, not as security.

  * Your ROLE: add ?role=<short label> to your /jack URL to announce a role
    ("architect", "reviewer", ...). It shows in your greeting, in /peers' `roles`
    map, and is stamped on every message you author (a `role` field on the entry).
  * Per-message TO / REPLY_TO / KIND: build the body as JSON instead of raw text:
    curl -s -X POST "{base}/send?t={token}&k={secret}" --data-binary @- <<'WIRE'
{{"body": "your message", "to": ["peer-2"], "reply_to": 12, "kind": "question"}}
WIRE
      - "to": a handle or list of handles this message is for (omit/empty = to all);
      - "reply_to": the seq of the message you're answering;
      - "kind": a free-form tag for the message ("question", "decision", ...).
    Each is optional; whatever you include is echoed in the send reply, rides the
    recv entries + `missed` arrays, and shows in /trace. A plain raw-text body (or
    a {{"body": "..."}} with none of these keys) carries none of them, as before.
  * CONVERGING a group (a convention, NOT special server handling): to reach a
    decision, post your proposal with kind:"propose" (or kind:"decision"), and
    others agree with kind:"ack" (optionally reply_to the proposal's seq):
      curl -s -X POST "{base}/send?t={token}&k={secret}" --data-binary @- <<'WIRE'
{{"body": "let's ship option A", "kind": "propose"}}
WIRE
    These just ride the existing free-form `kind` field -- the relay does nothing
    special with them, but they show in /trace and recv so everyone (including the
    last peer standing) can watch consensus form and know it's safe to unplug.
    Pair with the send reply's `caught_up` to confirm the decision was seen.
  * Read only what's FOR YOU: add ?mine=1 to recv to receive only broadcasts +
    messages addressed to your handle (plus all join/leave/closed notices):
      curl -s --max-time 35 "{base}/recv?t={token}&k={secret}&mine=1"
    This changes only what THIS call returns -- your read position still advances
    past everything, so messages for others are skipped, not queued. Plain recv
    (no ?mine) still delivers the full group log.
  * Skip your OWN echo: add ?exclude_me=1 to recv to receive only OTHERS'
    messages (your own posts, normally echoed back, are dropped):
      curl -s --max-time 35 "{base}/recv?t={token}&k={secret}&exclude_me=1"
    Like ?mine, this changes only what THIS call returns -- your cursor still
    advances past everything (including your own posts), so nothing is queued.
    Combine with ?mine for "only what's for me, minus my own echo":
      curl -s --max-time 35 "{base}/recv?t={token}&k={secret}&mine=1&exclude_me=1"
  * RE-READ FROM A SEQ (resync/peek): add ?since=<seq> to recv to fetch every
    message with seq GREATER THAN <seq>, returned RIGHT AWAY as a JSON array (no
    long-poll):
      curl -s "{base}/recv?t={token}&k={secret}&since=42"
    This is HISTORICAL -- a snapshot for catching up or filling a gap. It does NOT
    move your read position, so your normal recv loop is unaffected (and a closed
    conversation's "conversation closed" line comes back INSIDE the array, NOT as
    the terminal stop-object -- so a ?since result is NEVER a "keep going" signal;
    do not treat it as one). Use plain recv (below) as your live loop; use ?since
    only to look back.

(The relay may WINDOW a very long catch-up: if a single recv would hand you a big
backlog at once, it returns an object {{"entries": [...], "truncated": true,
"remaining": <n>, "next_since": <seq>, "hint": "..."}} with only the first slice.
This is NOT the conversation closing. Just run the SAME recv again to get the next
slice (it resumes with no gap), or fetch the rest now with ?since=<next_since>.
When there is no truncation, recv is a plain array as usual.)

ETIQUETTE -- READ THIS:
  Only post when you ADD something. Do NOT post acknowledgement-only or
  pleasantry messages. If you have nothing to add, just run recv again. When
  the task is resolved, run unplug. Unplug is FINAL for this session -- there is
  no rejoin; everyone else sees a "{handle} left" line when you go.

Re-read or watch the whole thread anytime (no token, doesn't move your position):
  curl -s "{base}/trace?k={secret}"
(When the conversation closes, the relay persists the full transcript -- the same
text /trace renders -- to disk, so the record survives after the room exits. That
on-disk copy is the only way to read the conversation AFTER it closes: /trace
itself is NOT available once the room closes -- the process exits, so a connection
error on /trace post-close is EXPECTED, not a failure.)

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

    # -- the base URL ({scheme}://{authority}) to advertise in manuals. -------
    # Precedence:
    #   1. PUBLIC_BASE (RELAY_PUBLIC_BASE env / --public-base) -- used VERBATIM,
    #      the explicit override for a proxy the header sniff can't infer.
    #   2. Derive from the request: scheme = the first X-Forwarded-Proto value if
    #      the proxy set one (else http); authority = the Host header EXACTLY as the
    #      client sent it (keep its port iff it carried one -- so a LAN client's
    #      ":<port>" survives, an ngrok host with none stays portless). This is the
    #      reverse-proxy auto-detect: behind ngrok the client's Host is the public
    #      hostname and XFP is https, so the manual prints https://host with no port.
    #   3. No Host header at all -> fall back to the configured {adv_host}:{PORT}.
    # The base is COSMETIC -- it is only what the manual PRINTS. Honoring client
    # headers here is NOT a security surface: a spoofed Host/X-Forwarded-Proto only
    # changes a printed URL, never routing and never the ?k= gate.
    def _advertised(self) -> str:
        if PUBLIC_BASE:
            return PUBLIC_BASE
        host_hdr = self.headers.get("Host", "")
        if host_hdr:
            # First value of a possibly comma-listed X-Forwarded-Proto, else http.
            xfp = self.headers.get("X-Forwarded-Proto", "")
            scheme = xfp.split(",")[0].strip() if xfp else "http"
            # Authority verbatim -- preserve exactly what the client used (keep its
            # port iff present; do NOT reconstruct and re-append the local PORT).
            return f"{scheme}://{host_hdr}"
        adv_host = "127.0.0.1" if HOST in ("0.0.0.0", "") else HOST
        return f"http://{adv_host}:{PORT}"

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
            # OPTIONAL ?role=<str>: sanitize (newline-free, len-cap ROLE_MAX) and
            # store on the peer. Missing/empty -> "" -> today's behavior exactly.
            role = _norm_label(qs.get("role", [""])[0], ROLE_MAX)
            token, handle, peers_before = CONVO.join(role)
            base = self._advertised()
            role_note = f" role={role}" if role else ""
            print(f"[jack] handle={handle} token={token}{role_note} (peers now {peers_before + 1})")
            return self._text(200, build_manual(CONVO, token, handle, peers_before, base, SECRET, role))

        if path == "/recv":
            # Key gate FIRST, then the per-peer token -- the two are independent.
            if not self._key_ok(qs):
                return self._json(401, {"ok": False, "error": "bad or missing key"})
            token = qs.get("t", [""])[0]
            if not token:
                return self._json(400, {"ok": False, "error": "missing ?t=<token>"})
            # OPTIONAL ?since=<seq>: a SYNCHRONOUS, cursor-SAFE historical slice --
            # entries with seq > since, NO long-poll, NEVER advances the cursor.
            # Parse like ?last=/?mine= (suppress a garbage value -> fall through to
            # the normal long-poll recv below). A valid value short-circuits here.
            raw_since = qs.get("since", [""])[0]
            if raw_since:
                with contextlib.suppress(ValueError):
                    since = int(raw_since)
                    status, payload = CONVO.recv_since(token, since)
                    return self._json(status, payload)
            wait = self._clamp_wait(qs.get("wait", [str(DEFAULT_WAIT)])[0])
            # OPTIONAL ?mine=1 advisory filter: any truthy value (1/true/yes) turns
            # it on. Absent/empty/0 -> the full group log, unchanged. The relay
            # never enforces routing -- this only narrows what THIS call returns;
            # the cursor still advances past everything (see Conversation.recv).
            mine = qs.get("mine", [""])[0].lower() in ("1", "true", "yes", "on")
            # OPTIONAL ?exclude_me=1 advisory filter: any truthy value (1/true/yes)
            # turns it on. Absent/empty/0 -> own posts are kept, unchanged. Like
            # ?mine it only narrows what THIS call returns (system notices always
            # pass); the cursor still advances past everything (see Conversation.recv).
            exclude_me = qs.get("exclude_me", [""])[0].lower() in ("1", "true", "yes", "on")
            status, payload = CONVO.recv(token, wait, mine, exclude_me)
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

        if path == "/floor":
            # Advisory soft turn-grant. Gated like /send: needs BOTH ?k= (secret)
            # and ?t= (token) -- the floor is a per-peer credentialed action. ?op=
            # defaults to "status" (read-only) when absent/empty, so a bare
            # /floor?t=&k= is a harmless snapshot. The relay NEVER blocks a send on
            # this; /floor only records + reports whose turn it is.
            if not self._key_ok(qs):
                return self._json(401, {"ok": False, "error": "bad or missing key"})
            token = qs.get("t", [""])[0]
            if not token:
                return self._json(400, {"ok": False, "error": "missing ?t=<token>"})
            op = qs.get("op", ["status"])[0] or "status"
            status, payload = CONVO._floor_op(token, op)
            return self._json(status, payload)

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
            # Read body + optional addressing envelope through the ONE choke point
            # (_read_envelope -> _read_body), so the MAX_BODY size cap still gates
            # both the raw and {"body":...} paths -- the 413 below is the same path
            # as before. `env` carries the raw to/reply_to/kind (or {}); send()
            # sanitizes them, so a raw/legacy send (env={}) is byte-identical.
            ok, body, env = self._read_envelope()
            if not ok:
                # Body exceeded RELAY_MAX_BODY. Reject BEFORE the send path so the
                # oversized post never appends. Close the connection: we did NOT
                # drain the body off the socket, so reusing it (HTTP keep-alive)
                # would desync the next request against those leftover bytes.
                self.close_connection = True
                return self._json(413, {"ok": False, "error": "body too large", "max_bytes": MAX_BODY})
            # Optional ?last=<seq>: opt-in cursor-checked send. Parse to int; a
            # missing/garbage value stays None -> the legacy (unguarded) path.
            last = None
            raw_last = qs.get("last", [""])[0]
            if raw_last:
                with contextlib.suppress(ValueError):
                    last = int(raw_last)
            status, payload = CONVO.send(
                token, body, last, to=env.get("to"), reply_to=env.get("reply_to"), kind=env.get("kind")
            )
            return self._json(status, payload)

        return self._text(404, "not found\n")

    # -- request helpers ---------------------------------------------------

    def _read_body(self) -> tuple[bool, str]:
        """Read the POST body. Accept either a raw body or JSON {"body": "..."}.
        We sniff for JSON only when it parses to a dict containing 'body'.

        Returns (ok, text). `ok` is False ONLY when the SIZE CAP (MAX_BODY) is
        tripped -- the caller turns that into an HTTP 413. The cap is the single
        body-read choke point: it is checked here, BEFORE the JSON sniff, so both
        the raw-body and {"body": ...} paths are bounded (and any future parse
        layered on this read inherits the cap for free -- see _read_envelope). An
        over-cap body is rejected BEFORE it is allocated/read -- we never pull the
        bytes off the socket. When MAX_BODY is 0 the cap is OFF (unlimited).

        SIDE EFFECT for layered parses: when the body WAS a JSON dict carrying
        'body', the full parsed dict is stashed on self._last_envelope so a caller
        like _read_envelope can lift the sibling addressing fields (to/reply_to/
        kind) WITHOUT re-reading the socket. A raw (non-JSON) body leaves it None.
        This keeps _read_body the ONE place that touches the socket + the cap."""
        self._last_envelope = None
        length = int(self.headers.get("Content-Length", "0") or "0")
        # SIZE CAP: reject up front when the declared length exceeds the ceiling,
        # before allocating/reading. The caller sets close_connection on the 413
        # so the unread body can't desync HTTP keep-alive.
        if MAX_BODY > 0 and length > MAX_BODY:
            return False, ""
        # Belt-and-suspenders: even on the accepted path, never read more than the
        # cap (a lying Content-Length can't make us over-allocate).
        to_read = min(length, MAX_BODY) if MAX_BODY > 0 else length
        raw = self.rfile.read(to_read) if to_read else b""
        text = raw.decode("utf-8", "replace")
        stripped = text.strip()
        if stripped.startswith("{") and stripped.endswith("}"):
            try:
                obj = json.loads(stripped)
                if isinstance(obj, dict) and "body" in obj:
                    self._last_envelope = obj  # stash for _read_envelope's siblings
                    return True, str(obj["body"])
            except (ValueError, TypeError):
                pass  # not JSON we understand -> treat as raw text
        return True, text

    def _read_envelope(self) -> tuple[bool, str, dict]:
        """Read the POST body AS AN ADDRESSING ENVELOPE. Layers on _read_body so it
        INHERITS the MAX_BODY size cap unchanged (the 413 path is _read_body's, not
        a second one) -- the body bytes are read + capped exactly once.

        Returns (ok, body, env): `ok`/`body` are _read_body's (ok False == the size
        cap tripped -> the caller 413s, same as before). `env` is the RAW sibling
        addressing fields {to?, reply_to?, kind?} pulled from a {"body",...} JSON
        send (via the dict _read_body stashed); they are passed UNVALIDATED to
        Conversation.send(), which is the single place that sanitizes them. A raw
        body, or a JSON without those keys, yields env={} -> a legacy send carries
        NONE of the new fields, exactly as before the envelope existed."""
        ok, body = self._read_body()
        env: dict = {}
        if ok:
            obj = getattr(self, "_last_envelope", None)
            if isinstance(obj, dict):
                # Lift ONLY the recognized envelope keys, still raw -- send()
                # sanitizes. Unknown keys in the JSON are ignored (dumb pipe).
                for key in ("to", "reply_to", "kind"):
                    if key in obj:
                        env[key] = obj[key]
        return ok, body, env

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


def _extract_public_base(argv: list[str]) -> tuple[list[str], str | None]:
    """Pull an optional `--public-base <url>` (or `--public-base=<url>`) out of argv
    and return (argv_without_it, base_or_None). Mirrors _extract_room/_extract_secret/
    _extract_brief: the flag is stripped BEFORE the positional `host port` parse, so
    --public-base can sit anywhere on the line and coexist with --brief/--secret/
    --room (and the bare `relay.py 0.0.0.0 55555` launch is unaffected). A dangling
    `--public-base` with no value is ignored (treated as absent -> fall through to
    RELAY_PUBLIC_BASE env, else per-request header derivation)."""
    out: list[str] = []
    public_base: str | None = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--public-base":
            if i + 1 < len(argv):
                public_base = argv[i + 1]
                i += 2
            else:
                i += 1  # dangling --public-base with no value -> ignore
            continue
        if a.startswith("--public-base="):
            public_base = a[len("--public-base=") :]
            i += 1
            continue
        out.append(a)
        i += 1
    return out, public_base


def _reaper_loop(convo: Conversation) -> None:
    """The presence-reaper thread body. Wakes every REAP_INTERVAL seconds and asks
    the conversation to drop peers silent longer than PEER_TIMEOUT. Runs as a
    daemon (started in main()) so it dies with the process; it also returns on its
    own once the conversation closes -- reap_idle() short-circuits when closed, and
    we stop looping then so the thread doesn't spin during the shutdown grace.

    WHY a thread and not a lazy on-request sweep: if EVERY agent dies silently, no
    request ever arrives to trigger a lazy check, so the room would never empty and
    never close -- the exact leak this fixes. The thread guarantees the room closes
    (and the process exits) even when all peers vanish at once."""
    while not convo.closed:
        time.sleep(REAP_INTERVAL)
        try:
            convo.reap_idle()
        except Exception as e:  # never let a sweep error kill the thread silently
            print(f"[warn] reaper sweep error: {e}", file=sys.stderr)


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
    global HOST, PORT, SECRET, ROOM, PIDFILE, PORTFILE, SECRETFILE, PUBLIC_BASE
    # Strip --brief, --secret, --room AND --public-base first so none disturbs the
    # positional host/port parse. All four can sit anywhere on the line and coexist
    # on one launch; what's left in `args` is just the positional host/port (if any).
    args, brief = _extract_brief(sys.argv[1:])
    args, secret = _extract_secret(args)
    args, room = _extract_room(args)
    args, public_base = _extract_public_base(args)
    # argv --public-base wins over the RELAY_PUBLIC_BASE env (seeded into PUBLIC_BASE
    # at import); a trailing slash is stripped so "{base}/recv" stays clean. Unset on
    # both -> PUBLIC_BASE stays "" and _advertised() derives the base per request.
    if public_base is not None:
        PUBLIC_BASE = public_base.rstrip("/")

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

    # Start the presence reaper now that the close path is wired (so a reap that
    # empties the room can fire _on_close cleanly). Daemon: it dies with the
    # process and needs no join on shutdown. It guarantees the room closes even if
    # every peer dies silently and no further request ever arrives.
    threading.Thread(target=_reaper_loop, args=(CONVO,), name="wire-reaper", daemon=True).start()

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
    print(
        f"  caps   : turns={MAX_TURNS} wall={MAX_SECONDS}s repeat-window={REPEAT_WINDOW} "
        f"max-body={MAX_BODY}B min-send-interval={MIN_SEND_INTERVAL}s floor-lease={FLOOR_LEASE}s"
    )

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
