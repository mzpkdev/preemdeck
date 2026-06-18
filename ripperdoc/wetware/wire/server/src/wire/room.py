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
    """One room message. The HTTP layer renames ``sender`` to ``from`` in JSON."""

    seq: int
    sender: str
    message: str


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
        self._messages: list[Message] = []
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

    def jackin(self, requested: str | None = None) -> tuple[str, str]:
        """Mint a token bound to a peer name. Returns ``(token, name)``.

        The counter always advances, so a generic ``peer-{counter}`` fallback is
        always available. If ``requested`` is given and passes every guard it is
        assigned (original casing preserved for display); otherwise the peer
        silently gets the fallback — there is no error path. Guards:

        * matches ``[A-Za-z0-9_-]{1,32}`` after stripping surrounding whitespace;
        * is not a reserved ``peer-N`` form (no impersonating the auto-scheme);
        * is not already taken — compared case-insensitively against every name
          ever assigned this room (alive or dead, since a name is bound for the
          room's life), so ``Alice`` blocks a later ``alice``.
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
        return token, name

    def jackout(self, token: str) -> str:
        """Retire ``token``: mark its peer not-connected. Returns the peer name.

        Caller is expected to have validated the token first (status VALID);
        raises ``KeyError`` for an unknown token.
        """
        peer = self._peers[token]
        peer.connected = False
        return peer.name

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
        ``seq``. Wakes parked recv waiters. Returns the assigned seq.

        Caller is expected to have validated the token; raises ``KeyError`` for
        an unknown token.
        """
        peer = self._peers[token]
        async with self._cond:
            self._seq += 1
            seq = self._seq
            self._messages.append(Message(seq=seq, sender=peer.name, message=text))
            peer.last_sent = seq
            self._cond.notify_all()
        return seq

    async def recv(self, token: str, wait: float | None = None) -> dict:
        """Long-poll for this token's unread messages.

        Returns a dict with ``unread`` (list[Message]), ``peers`` (list[str]),
        and ``read_your_last_message`` (list[str]). If unread already exist,
        returns at once. Otherwise parks up to ``wait`` seconds on the room
        condition; on timeout returns a heartbeat (``unread=[]``) with the
        cursor unchanged. A peer never sees its own messages in ``unread`` —
        unread is messages with ``seq > cursor`` whose sender is *not* this
        peer. The cursor advances only on actually-delivered (non-own) messages.

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
                        "unread": [],
                        "peers": self.peers(),
                        "read_your_last_message": self._read_your_last_message(peer),
                    }

            # A peer never sees its own messages in unread. seq is global, so
            # other peers may interleave below our own send; filtering by sender
            # here (not by jumping the cursor on send) keeps their messages from
            # being skipped.
            unread = [m for m in self._messages if m.seq > peer.cursor and m.sender != peer.name]
            if unread:
                # Advance only to the max seq actually delivered (non-own). An
                # own message sitting above this max stays filtered on later
                # recvs — harmless; own messages below it are naturally excluded.
                peer.cursor = unread[-1].seq
            return {
                "unread": unread,
                "peers": self.peers(),
                "read_your_last_message": self._read_your_last_message(peer),
            }

    def _has_unread(self, peer: _Peer) -> bool:
        """True iff some message past ``peer``'s cursor was sent by *someone
        else*. A peer's own messages never count as unread, so if only its own
        messages sit past the cursor, recv parks and heartbeats."""
        return any(m.seq > peer.cursor and m.sender != peer.name for m in self._messages)
