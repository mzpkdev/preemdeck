"""The framework-free core of a wire room.

Holds all room state — token->peer binding, the message log, the room-global
event-``id`` counter (stream position / read cursor key) plus a separate
message-only ``seq`` counter, per-token read cursors, and the long-poll wake.
Imports neither FastAPI nor pydantic; depends only on :mod:`wire.config`. One
event loop, no threads — a single ``asyncio.Condition`` guards the long-poll.
"""

from __future__ import annotations

import asyncio
import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum

from .config import Config

# Internal whitespace runs and underscores fold to a single `-` (full kebab: so
# "my agent" and "my_agent" both -> "my-agent", not deleted) — `-` is the only
# separator, doubling as the `-<n>` suffix delimiter.
_WS_RE = re.compile(r"[\s_]+")
# After lowercasing + folding to `-`, anything outside this set is stripped (no
# underscore in the output set — true kebab).
_NAME_CHARS_RE = re.compile(r"[^a-z0-9-]")
# Slug-clean: collapse consecutive `-` runs to one (e.g. "a--b" -> "a-b").
_SEP_RUN_RE = re.compile(r"-{2,}")
# Cap on a name base after normalizing (the `<n>` suffix is appended on top).
_BASE_MAX = 32
# Base used when no usable name was requested.
_DEFAULT_BASE = "peer"


class TokenStatus(Enum):
    """Outcome of validating a token, for the auth layer to map to a 401 body.

    Tokens are IMMORTAL: once /jackin mints one it is VALID for the room's life;
    nothing — neither jackout nor an idle drop — invalidates it. Roster presence
    is separate state (see :attr:`_Peer.in_roster`), so this is just a two-way
    "minted here or not" verdict.

    UNKNOWN  — never minted (or malformed)  -> "invalid token"
    VALID    — minted by this room          -> proceed
    """

    UNKNOWN = "unknown"
    VALID = "valid"


@dataclass
class Message:
    """One room message. The HTTP layer renames ``sender`` to ``from`` in JSON.

    A log entry of ``type == "message"`` — its *subject* (the peer it's about,
    for the don't-echo-me filter) is its ``sender``. Carries TWO counters: ``id``
    is the room-global event id (its stream position / read-cursor key, shared
    with presence events), while ``seq`` is the message-only counter that climbs
    1, 2, 3… with no gaps — presence events never burn a ``seq``.
    """

    id: int
    seq: int
    sender: str
    message: str
    # Authoritative send time, stamped in Room.send(): ISO-8601 UTC, second
    # precision, Z-suffixed (e.g. "2026-06-18T13:57:02Z"). id still defines
    # stream order; this is the wall-clock instant the message was created.
    sent_at: str
    type: str = "message"


@dataclass
class Presence:
    """A join/leave event. A log entry that rides the same event-``id``-ordered
    stream as messages; its ``type`` is literally ``"action(join)"`` or
    ``"action(leave)"`` (the parens are part of the wire string). Its *subject*
    (the peer it's about, for the don't-echo-me filter) is its ``peer``. Unlike
    a message it carries only ``id`` (the room-global event id) — there is no
    message-only ``seq`` on presence.
    """

    id: int
    peer: str
    # Same stamp contract as Message.sent_at: ISO-8601 UTC, second precision, Z.
    sent_at: str
    type: str  # "action(join)" | "action(leave)"


# A log entry is either a message or a presence event; both carry id/type/
# sent_at, and both have a *subject* — the peer the entry is about, used to skip
# entries about the caller in recv().
LogEntry = Message | Presence


def _subject(entry: LogEntry) -> str:
    """The peer a log entry is *about*: the sender of a message, or the peer of
    a presence event. recv() never delivers an entry whose subject is the caller
    (generalizes don't-echo-my-own-message to skip-events-about-me)."""
    return entry.sender if isinstance(entry, Message) else entry.peer


def _now_iso() -> str:
    """Authoritative wall-clock stamp: ISO-8601 UTC, second precision, Z-form."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


@dataclass
class _Peer:
    """Internal per-token state."""

    name: str
    # Whether this peer is currently SHOWN in the roster — "recently active",
    # NOT token liveness (the token is immortal). Flipped only by _set_present:
    # True on join (jackin / activity after a drop), False on leave (jackout /
    # idle reap). peers() lists exactly the in_roster peers.
    in_roster: bool = True
    # Monotonic seconds (via Room._now) of this peer's last token-bearing call —
    # stamped on jackin and at /recv ENTRY, /send, /jackout. The idle reaper drops
    # a peer once now - last_active exceeds the idle timeout. 0.0 until first set.
    last_active: float = 0.0
    # Highest event id this token has been delivered (its read cursor). 0 = nothing read.
    cursor: int = 0
    # Highest event id this token has itself sent (0 = has never sent).
    last_sent: int = 0


class Room:
    """The pure async core. Construct from a :class:`~wire.config.Config`."""

    def __init__(self, config: Config, now: Callable[[], float] = time.monotonic) -> None:
        self.config = config
        # The room's idle threshold (seconds); 0 disables idle drop entirely.
        self._idle_timeout = config.idle_timeout
        # The empty-room grace (seconds); 0 disables empty-room self-close.
        self._empty_grace = config.empty_grace
        # Monotonic clock SEAM. Every elapsed-time read goes through self._now();
        # time.monotonic() is never called directly outside this default. Tests
        # swap self._now to drive reap_idle without real sleeps.
        self._now = now
        # idle_timeout MUST outrun wait_max: a parked /recv holds a peer silent up
        # to wait_max, and last_active is stamped at recv ENTRY, so a peer that
        # re-polls within idle_timeout stays alive. If idle <= wait_max a quiet
        # but healthy long-poller could be reaped mid-park.
        if self._idle_timeout > 0:
            assert self._idle_timeout > config.wait_max, (
                f"idle_timeout ({self._idle_timeout}) must exceed wait_max ({config.wait_max}); "
                "a parked /recv holds a peer silent up to wait_max and would otherwise be reaped"
            )
        # Heterogeneous, event-id-ordered: messages and presence events interleave.
        self._messages: list[LogEntry] = []
        # Room-global event id: the stream position / read-cursor key, bumped for
        # EVERY log entry (message or presence). Renamed from the old `_seq`.
        self._event_id: int = 0
        # Message-only counter: climbs 1, 2, 3… with no gaps, untouched by
        # presence events. Stamped onto Message.seq; first message -> seq 1.
        self._msg_seq: int = 0
        # Monotonic instant (via self._now) of the most recent CHAT message —
        # what drives recv's `quiet_for`. Stamped in send() only; presence
        # join/leave is not talk and never touches it. None until the first
        # message, so `quiet_for` reads null on a room where no one has spoken.
        # Monotonic (not the wall-clock Message.sent_at) so it rides the same
        # clock seam as the idle reaper and moves under the tests' _now swap.
        self._last_msg_at: float | None = None
        # token -> _Peer
        self._peers: dict[str, _Peer] = {}
        # names in join order (never shrinks; a name is bound for the room's life)
        self._join_order: list[str] = []
        self._cond = asyncio.Condition()
        # Monotonic instant the roster last became empty, or None while occupied.
        # BOOT-ARMED: stamped to "now" at construction so a never-joined room has
        # a live countdown from boot (the first jackin clears it to None). Read
        # only under self._cond and maintained in exactly one place — the
        # _set_present choke point — so every roster flip keeps it honest.
        self._empty_since: float | None = self._now()

    # -- token validation surface (for the auth layer) --------------------

    def status(self, token: str) -> TokenStatus:
        """Two-way verdict on a token: UNKNOWN (never minted) or VALID.

        Tokens are immortal — neither jackout nor an idle drop kills one — so a
        known token is always VALID; only an unminted/malformed token is UNKNOWN.
        Roster presence (jacked out, reaped) is orthogonal and lives on the peer.
        """
        return TokenStatus.VALID if token in self._peers else TokenStatus.UNKNOWN

    def is_known(self, token: str) -> bool:
        """True if the token was ever minted by this room (in roster or not)."""
        return token in self._peers

    def peer_name_for(self, token: str) -> str | None:
        """Peer name bound to ``token``, or ``None`` if never minted.

        Returns the name even for a peer that's out of the roster (jacked out or
        reaped), since the token->name binding is permanent for the room's life.
        """
        peer = self._peers.get(token)
        return peer.name if peer is not None else None

    # -- membership -------------------------------------------------------

    async def jackin(self, requested: str | None = None) -> tuple[str, str]:
        """Mint a token bound to a peer name, then announce the join. Returns
        ``(token, name)``.

        Every assigned name is ``<base>-<n>`` — a number is always appended.
        ``base`` is the ``requested`` name normalized (trimmed, lowercased, inner
        whitespace and underscores -> ``-``, slugified to ``[a-z0-9-]``, capped at 32 chars; see
        :meth:`_assign_name`); if it's absent, empty, or nothing survives, ``base``
        falls back to ``"peer"``. ``n`` is
        the lowest positive integer such that ``<base>-<n>`` is not already taken
        — compared case-insensitively against every name ever assigned this room
        (alive or dead, since a name is bound for the room's life). So the first
        ``alice`` lands on ``alice-1``, a second on ``alice-2``; unnamed peers
        run ``peer-1``, ``peer-2``, …; and the two sequences are independent
        (numbering is per-base, never global), so a named peer never leaves a gap
        in the ``peer-N`` line. There is no error path — a request always
        resolves to some ``<base>-<n>``.

        After the peer enters the roster, appends an ``action(join)`` presence
        entry on the next event ``id`` and wakes parked recvs, so every *other*
        peer sees the join on its stream (the joiner filters its own out in recv).
        """
        token = secrets.token_urlsafe(32)
        name = self._assign_name(requested)
        # Created OUT of the roster, then flipped in via the single _set_present
        # choke point so the join announce shares that one code path; activity is
        # stamped first so the fresh peer starts its idle clock now.
        peer = _Peer(name=name, in_roster=False)
        self._peers[token] = peer
        self._join_order.append(name)
        async with self._cond:
            peer.last_active = self._now()
            await self._set_present(peer, True, "action(join)")
        return token, name

    def _assign_name(self, requested: str | None) -> str:
        """Resolve ``requested`` to a ``<base>-<n>`` name unique in this room.

        ``base`` is normalized from the request, in order: trim surrounding
        whitespace; lowercase; fold internal whitespace runs *and* underscores
        to a single ``-`` (full kebab: so "my agent" and "my_agent" both ->
        "my-agent", not deleted — ``-`` is the only separator, doubling as the
        ``-<n>`` delimiter); strip any char outside ``[a-z0-9-]`` (no underscore
        in the output); slug-clean (collapse ``-`` runs to one and strip
        leading/trailing ``-``); cap at 32 chars; empty after all that ->
        ``peer``. ``n`` =
        the lowest positive integer for which ``<base>-<n>`` is not yet taken
        (case-insensitive — though bases are now lowercase — against every name
        ever assigned)."""
        base = _DEFAULT_BASE
        if requested is not None:
            slug = _WS_RE.sub("-", requested.strip().lower())
            slug = _NAME_CHARS_RE.sub("", slug)
            slug = _SEP_RUN_RE.sub("-", slug).strip("-")[:_BASE_MAX]
            if slug:
                base = slug
        taken = {n.casefold() for n in self._join_order}
        n = 1
        while f"{base}-{n}".casefold() in taken:
            n += 1
        return f"{base}-{n}"

    async def touch(self, token: str) -> None:
        """Mark ``token``'s peer recently active, rejoining it if it had dropped.

        The ONE activity choke point: called at the top of every token-bearing
        handler (/recv ENTRY, /send, /jackout). Stamps ``last_active`` so the
        idle reaper leaves a busy peer alone, and — if the peer was out of the
        roster (jacked out or reaped) — flips it back in via ``_set_present``,
        emitting exactly one ``action(join)``. A no-op on roster membership for a
        peer already present (just the activity stamp).

        Caller is expected to have validated the token; raises ``KeyError`` for
        an unknown token.
        """
        peer = self._peers[token]
        async with self._cond:
            await self._mark_active(peer)

    async def _mark_active(self, peer: _Peer) -> None:
        """Stamp ``peer`` active now and rejoin it if it had dropped. Assumes the
        caller already holds ``self._cond``. The shared body behind :meth:`touch`
        and the entry-stamp in send/recv/jackout, so activity is recorded through
        one path no matter which call carried the token."""
        peer.last_active = self._now()
        await self._set_present(peer, True, "action(join)")

    async def jackout(self, token: str) -> str:
        """Drop ``token``'s peer from the roster, then announce the leave. Returns
        the peer name. Does NOT kill the token — it stays VALID, and the peer's
        next token-bearing call rejoins it (via :meth:`touch`).

        Appends an ``action(leave)`` presence entry on the next event ``id`` and
        wakes parked recvs, so every *other* peer sees the leave on its stream.

        Caller is expected to have validated the token first (status VALID);
        raises ``KeyError`` for an unknown token.
        """
        peer = self._peers[token]
        async with self._cond:
            # Stamp the activity directly (NOT via _mark_active, which would
            # rejoin) so jackout's net roster effect is purely the leave — a peer
            # that had already dropped doesn't churn an extra join here.
            peer.last_active = self._now()
            await self._set_present(peer, False, "action(leave)")
        return peer.name

    async def reap_idle(self) -> None:
        """Drop every peer idle longer than the configured ``idle_timeout``.

        For each in-roster peer with ``self._now() - last_active > idle_timeout``,
        flips it out via :meth:`_set_present`, emitting one ``action(leave)`` per
        dropped peer (rosters transitions fire the SAME presence event as an
        explicit jackout — idle drop is just an implicit leave). A no-op when
        ``idle_timeout == 0`` (idle drop disabled). Idempotent: a peer already
        out of the roster never re-emits a leave.

        Phase 1 implements and unit-tests this; the background task that calls it
        on an interval is Phase 2. The whole sweep runs under ``self._cond`` so
        the reaper-vs-rejoin race resolves to exactly one announce per peer.
        """
        if self._idle_timeout == 0:
            return
        async with self._cond:
            now = self._now()
            for peer in list(self._peers.values()):
                if peer.in_roster and now - peer.last_active > self._idle_timeout:
                    await self._set_present(peer, False, "action(leave)")

    async def _set_present(self, peer: _Peer, present: bool, event_type: str) -> None:
        """The ONE place roster membership flips. Idempotent.

        MUST be called while already holding ``self._cond`` (every caller —
        jackin, touch, jackout, reap_idle — wraps it in ``async with self._cond``).
        Holding the lock across the ``in_roster == present`` guard is what makes
        the reaper-vs-rejoin race on the single event loop resolve to exactly one
        announce: whichever runs first flips the flag, and the other sees the
        guard and returns. On a real transition it appends the matching presence
        entry (``event_type`` is ``action(join)`` or ``action(leave)``) on the
        next event id and wakes parked recvs.
        """
        if peer.in_roster == present:
            return
        peer.in_roster = present
        self._event_id += 1
        self._messages.append(Presence(id=self._event_id, peer=peer.name, sent_at=_now_iso(), type=event_type))
        self._cond.notify_all()
        # Maintain the empty-room stamp from the POST-flip roster, in this single
        # choke point so jackin/jackout/touch/reap_idle all keep it honest for
        # free. Only real transitions reach here (the guard above returned early
        # otherwise), and the caller holds self._cond. Re-stamp on the flip that
        # empties the roster; clear to None whenever anyone is present (the first
        # join clears the boot-armed stamp; the last leave/reap re-arms it).
        roster_empty = not any(p.in_roster for p in self._peers.values())
        if roster_empty:
            if self._empty_since is None:
                self._empty_since = self._now()
        else:
            self._empty_since = None

    def peers(self) -> list[str]:
        """Currently in-roster peer names, in join order."""
        in_roster = {p.name for p in self._peers.values() if p.in_roster}
        return [name for name in self._join_order if name in in_roster]

    async def should_self_close(self) -> bool:
        """Whether the empty-room grace has elapsed — a PURE decision, no effects.

        True iff empty-room self-close is enabled (``empty_grace > 0``) and the
        roster has now been empty longer than ``empty_grace``. Never acts: it
        touches no signal, app, or task — it only reports the verdict for the
        Phase 2 caller to act on. STRICT ``>`` (matching the idle reaper): at
        exactly ``empty_grace`` the room survives.

        Reads ``_empty_since`` under ``self._cond`` (self-locking, like
        :meth:`reap_idle`); the BOOT-ARMED stamp means a never-joined room counts
        from construction. Taking the lock is what closes the last-instant join
        race on the decision side — a /jackin that lands first has already
        cleared ``_empty_since`` to None via :meth:`_set_present`.
        """
        if self._empty_grace == 0:
            return False
        async with self._cond:
            return self._empty_since is not None and (self._now() - self._empty_since) > self._empty_grace

    # -- messaging --------------------------------------------------------

    def _read_your_last_message(self, peer: _Peer) -> list[str]:
        """In-roster peers (excluding self) whose cursor has reached ``peer``'s
        most recent sent message. Empty if this peer hasn't sent anything."""
        if peer.last_sent == 0:
            return []
        readers = {
            p.name for p in self._peers.values() if p.in_roster and p.name != peer.name and p.cursor >= peer.last_sent
        }
        return [name for name in self._join_order if name in readers]

    async def send(self, token: str, text: str) -> tuple[int, int]:
        """Append a message from ``token``'s peer, stamped with the next event
        ``id`` (stream position), its own gap-free message ``seq``, and the
        authoritative send time (``sent_at``, ISO-8601 UTC). Wakes parked recv
        waiters. Returns ``(id, seq)``: the event id and the message-only seq.

        Caller is expected to have validated the token; raises ``KeyError`` for
        an unknown token.
        """
        peer = self._peers[token]
        async with self._cond:
            # Activity choke point: stamp + rejoin if dropped, BEFORE the message
            # is logged. A rejoin's join entry takes the earlier id, the message
            # the next — both wake the same parked recvs under this one lock.
            await self._mark_active(peer)
            self._event_id += 1
            self._msg_seq += 1
            event_id, msg_seq = self._event_id, self._msg_seq
            self._messages.append(Message(id=event_id, seq=msg_seq, sender=peer.name, message=text, sent_at=_now_iso()))
            # Mark the room's last-talk instant on the monotonic seam (same
            # clock the idle reaper reads) so recv's `quiet_for` measures the
            # lull from here. Only chat moves it — presence is not talk.
            self._last_msg_at = self._now()
            # last_sent is the event id (stream position), NOT msg_seq —
            # read-receipts compare against other peers' id-based cursors.
            peer.last_sent = event_id
            self._cond.notify_all()
        return event_id, msg_seq

    def _quiet_for(self) -> int | None:
        """Whole seconds since the most recent CHAT message, or ``None`` if no
        message has been sent yet. Measured on the monotonic seam (``self._now``)
        against the last-talk stamp set in :meth:`send`, so it shares the clock
        the idle reaper uses; presence join/leave is not talk and never bumps it.
        Floored to whole seconds and clamped at 0 (never negative)."""
        if self._last_msg_at is None:
            return None
        return max(0, int(self._now() - self._last_msg_at))

    async def recv(self, token: str, wait: float | None = None) -> dict:
        """Long-poll for this token's unread events (messages + presence).

        Returns a dict with ``events`` (list[LogEntry] — messages and join/leave
        presence entries, event-id-ordered), ``present_peers`` (list[str] — the
        roster, who's in the room right now), ``read_your_last_message``
        (list[str]), and ``quiet_for`` (int|None — whole seconds since the last
        chat message, ``None`` before anyone has spoken). If deliverable events
        already exist, returns at once. Otherwise parks up to ``wait`` seconds on
        the room condition; on timeout returns a heartbeat (``events=[]``) with
        the cursor unchanged — still carrying ``present_peers`` and ``quiet_for``,
        so an empty heartbeat reads as a live, quiet room, not a dead one.

        A peer never sees events *about itself*: ``events`` are entries with
        ``id > cursor`` whose subject (a message's sender, a presence event's
        peer) is *not* this peer — so you get others' messages and others'
        joins/leaves, never your own. The cursor advances only over
        actually-delivered (non-own) entries.

        ``wait`` defaults to the config default and is clamped to the config max.
        Caller is expected to have validated the token first; raises ``KeyError``
        for an unknown token.
        """
        if wait is None:
            wait = self.config.wait_default
        wait = min(wait, self.config.wait_max)

        peer = self._peers[token]

        async with self._cond:
            # Activity choke point — stamp at recv ENTRY, before parking, so a
            # peer that re-polls within idle_timeout stays alive even though a
            # long park then holds it silent up to wait_max (< idle_timeout). If
            # it had dropped, this rejoins it (one join entry) before we read.
            # NEVER stamp on event return: a present-but-quiet long-poller would
            # then look idle and get reaped.
            await self._mark_active(peer)
            if not self._has_unread(peer):
                try:
                    await asyncio.wait_for(
                        self._cond.wait_for(lambda: self._has_unread(peer)),
                        timeout=wait,
                    )
                except (asyncio.TimeoutError, TimeoutError):
                    # Heartbeat: nothing new, cursor untouched. Still reports the
                    # roster and the lull so an empty heartbeat reads as alive.
                    return {
                        "events": [],
                        "present_peers": self.peers(),
                        "read_your_last_message": self._read_your_last_message(peer),
                        "quiet_for": self._quiet_for(),
                    }

            # A peer never sees events about itself. id is global, so others'
            # entries may interleave below our own; filtering by subject here
            # (not by jumping the cursor) keeps theirs from being skipped.
            events = [e for e in self._messages if e.id > peer.cursor and _subject(e) != peer.name]
            if events:
                # Advance only to the max id actually delivered (non-own). An
                # own entry sitting above this max stays filtered on later
                # recvs — harmless; own entries below it are naturally excluded.
                peer.cursor = events[-1].id
            return {
                "events": events,
                "present_peers": self.peers(),
                "read_your_last_message": self._read_your_last_message(peer),
                "quiet_for": self._quiet_for(),
            }

    def _has_unread(self, peer: _Peer) -> bool:
        """True iff some log entry past ``peer``'s cursor is about *someone
        else*. A peer's own entries (its messages, its own join/leave) never
        count, so if only its own sit past the cursor, recv parks and
        heartbeats."""
        return any(e.id > peer.cursor and _subject(e) != peer.name for e in self._messages)
