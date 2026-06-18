"""The framework-free core of a wire room.

Holds all room state — token->peer binding, the message log, the room-global
``seq`` counter, per-token read cursors, and the long-poll wake. Imports neither
FastAPI nor pydantic; depends only on :mod:`wire.config`. One event loop, no
threads — a single ``asyncio.Condition`` guards the long-poll.
"""

from __future__ import annotations

import asyncio
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum

from .config import Config

# A self-requested name must be 1-32 chars of [A-Za-z0-9_-] (checked after
# stripping surrounding whitespace).
_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
# The auto-assigned scheme — a requested name matching this is rejected so a
# peer can't impersonate the peer-N counter.
_RESERVED_RE = re.compile(r"^peer-\d+$")


class TokenStatus(Enum):
    """Outcome of validating a token, for the auth layer to map to a 401 body.

    UNKNOWN  — never minted (or malformed)  -> "invalid token"
    DEAD     — minted but jacked-out/reaped  -> "token no longer valid, jackin again"
    VALID    — minted and still connected    -> proceed
    """

    UNKNOWN = "unknown"
    DEAD = "dead"
    VALID = "valid"


@dataclass
class Message:
    """One room message. The HTTP layer renames ``sender`` to ``from`` in JSON.

    A log entry of ``type == "message"`` — its *subject* (the peer it's about,
    for the don't-echo-me filter) is its ``sender``.
    """

    seq: int
    sender: str
    message: str
    # Authoritative send time, stamped in Room.send(): ISO-8601 UTC, second
    # precision, Z-suffixed (e.g. "2026-06-18T13:57:02Z"). seq still defines
    # order; this is the wall-clock instant the message was created.
    sent_at: str
    type: str = "message"


@dataclass
class Presence:
    """A join/leave event. A log entry that rides the same seq-ordered stream
    as messages; its ``type`` is literally ``"action(join)"`` or
    ``"action(leave)"`` (the parens are part of the wire string). Its *subject*
    (the peer it's about, for the don't-echo-me filter) is its ``peer``.
    """

    seq: int
    peer: str
    # Same stamp contract as Message.sent_at: ISO-8601 UTC, second precision, Z.
    sent_at: str
    type: str  # "action(join)" | "action(leave)"


# A log entry is either a message or a presence event; both carry seq/type/
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
    connected: bool = True
    # Highest seq this token has been delivered (its read cursor). 0 = nothing read.
    cursor: int = 0
    # Highest seq this token has itself sent (0 = has never sent).
    last_sent: int = 0


class Room:
    """The pure async core. Construct from a :class:`~wire.config.Config`."""

    def __init__(self, config: Config) -> None:
        self.config = config
        # Heterogeneous, seq-ordered: messages and presence events interleave.
        self._messages: list[LogEntry] = []
        self._seq: int = 0
        self._peer_counter: int = 0
        # token -> _Peer
        self._peers: dict[str, _Peer] = {}
        # names in join order (never shrinks; a name is bound for the room's life)
        self._join_order: list[str] = []
        self._cond = asyncio.Condition()

    # -- token validation surface (for the auth layer) --------------------

    def status(self, token: str) -> TokenStatus:
        """Three-way verdict on a token: UNKNOWN, DEAD, or VALID."""
        peer = self._peers.get(token)
        if peer is None:
            return TokenStatus.UNKNOWN
        return TokenStatus.VALID if peer.connected else TokenStatus.DEAD

    def is_known(self, token: str) -> bool:
        """True if the token was ever minted by this room (alive or dead)."""
        return token in self._peers

    def peer_name_for(self, token: str) -> str | None:
        """Peer name bound to ``token``, or ``None`` if never minted.

        Returns the name even for a dead (jacked-out) token, since the binding
        is permanent for the room's life.
        """
        peer = self._peers.get(token)
        return peer.name if peer is not None else None

    # -- membership -------------------------------------------------------

    async def jackin(self, requested: str | None = None) -> tuple[str, str]:
        """Mint a token bound to a peer name, then announce the join. Returns
        ``(token, name)``.

        The counter always advances, so a generic ``peer-{counter}`` fallback is
        always available. If ``requested`` is given and passes every guard it is
        assigned (original casing preserved for display); otherwise the peer
        silently gets the fallback — there is no error path. Guards:

        * matches ``[A-Za-z0-9_-]{1,32}`` after stripping surrounding whitespace;
        * is not a reserved ``peer-N`` form (no impersonating the auto-scheme);
        * is not already taken — compared case-insensitively against every name
          ever assigned this room (alive or dead, since a name is bound for the
          room's life), so ``Alice`` blocks a later ``alice``.

        After the peer is connected, appends an ``action(join)`` presence entry
        on the next ``seq`` and wakes parked recvs, so every *other* peer sees
        the join on its stream (the joiner filters its own out in recv).
        """
        token = secrets.token_urlsafe(32)
        self._peer_counter += 1
        default = f"peer-{self._peer_counter}"
        name = default
        if requested is not None:
            candidate = requested.strip()
            taken = {n.casefold() for n in self._join_order}
            if _NAME_RE.match(candidate) and not _RESERVED_RE.match(candidate) and candidate.casefold() not in taken:
                name = candidate
        self._peers[token] = _Peer(name=name)
        self._join_order.append(name)
        await self._announce(name, "action(join)")
        return token, name

    async def jackout(self, token: str) -> str:
        """Retire ``token``: mark its peer not-connected, then announce the
        leave. Returns the peer name.

        Appends an ``action(leave)`` presence entry on the next ``seq`` and
        wakes parked recvs, so every *other* peer sees the leave on its stream.

        Caller is expected to have validated the token first (status VALID);
        raises ``KeyError`` for an unknown token.
        """
        peer = self._peers[token]
        peer.connected = False
        await self._announce(peer.name, "action(leave)")
        return peer.name

    async def _announce(self, peer_name: str, event_type: str) -> None:
        """Append a presence entry (join/leave) on the next global seq and wake
        parked recvs. Shares the seq counter and the wake with send()."""
        async with self._cond:
            self._seq += 1
            self._messages.append(Presence(seq=self._seq, peer=peer_name, sent_at=_now_iso(), type=event_type))
            self._cond.notify_all()

    def peers(self) -> list[str]:
        """Currently-connected peer names, in join order."""
        connected = {p.name for p in self._peers.values() if p.connected}
        return [name for name in self._join_order if name in connected]

    # -- messaging --------------------------------------------------------

    def _read_your_last_message(self, peer: _Peer) -> list[str]:
        """Connected peers (excluding self) whose cursor has reached ``peer``'s
        most recent sent message. Empty if this peer hasn't sent anything."""
        if peer.last_sent == 0:
            return []
        readers = {
            p.name for p in self._peers.values() if p.connected and p.name != peer.name and p.cursor >= peer.last_sent
        }
        return [name for name in self._join_order if name in readers]

    async def send(self, token: str, text: str) -> int:
        """Append a message from ``token``'s peer, stamped with the next global
        ``seq`` and the authoritative send time (``sent_at``, ISO-8601 UTC).
        Wakes parked recv waiters. Returns the assigned seq.

        Caller is expected to have validated the token; raises ``KeyError`` for
        an unknown token.
        """
        peer = self._peers[token]
        async with self._cond:
            self._seq += 1
            seq = self._seq
            self._messages.append(Message(seq=seq, sender=peer.name, message=text, sent_at=_now_iso()))
            peer.last_sent = seq
            self._cond.notify_all()
        return seq

    async def recv(self, token: str, wait: float | None = None) -> dict:
        """Long-poll for this token's unread events (messages + presence).

        Returns a dict with ``events`` (list[LogEntry] — messages and join/leave
        presence entries, seq-ordered), ``peers`` (list[str]), and
        ``read_your_last_message`` (list[str]). If deliverable events already
        exist, returns at once. Otherwise parks up to ``wait`` seconds on the
        room condition; on timeout returns a heartbeat (``events=[]``) with the
        cursor unchanged.

        A peer never sees events *about itself*: ``events`` are entries with
        ``seq > cursor`` whose subject (a message's sender, a presence event's
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
            if not self._has_unread(peer):
                try:
                    await asyncio.wait_for(
                        self._cond.wait_for(lambda: self._has_unread(peer)),
                        timeout=wait,
                    )
                except (asyncio.TimeoutError, TimeoutError):
                    # Heartbeat: nothing new, cursor untouched.
                    return {
                        "events": [],
                        "peers": self.peers(),
                        "read_your_last_message": self._read_your_last_message(peer),
                    }

            # A peer never sees events about itself. seq is global, so others'
            # entries may interleave below our own; filtering by subject here
            # (not by jumping the cursor) keeps theirs from being skipped.
            events = [e for e in self._messages if e.seq > peer.cursor and _subject(e) != peer.name]
            if events:
                # Advance only to the max seq actually delivered (non-own). An
                # own entry sitting above this max stays filtered on later
                # recvs — harmless; own entries below it are naturally excluded.
                peer.cursor = events[-1].seq
            return {
                "events": events,
                "peers": self.peers(),
                "read_your_last_message": self._read_your_last_message(peer),
            }

    def _has_unread(self, peer: _Peer) -> bool:
        """True iff some log entry past ``peer``'s cursor is about *someone
        else*. A peer's own entries (its messages, its own join/leave) never
        count, so if only its own sit past the cursor, recv parks and
        heartbeats."""
        return any(e.seq > peer.cursor and _subject(e) != peer.name for e in self._messages)
