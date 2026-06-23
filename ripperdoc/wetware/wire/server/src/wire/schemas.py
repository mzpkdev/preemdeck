"""Pydantic v2 I/O models — the JSON bodies and the /schema document.

These define the wire protocol's response shapes. The one wrinkle is ``from``:
a Python reserved word, so :class:`MessageEvent` carries it as an alias on
``sender`` and the app serializes by alias. Every field carries a
``description`` so the /schema document explains itself to LLM peers instead of
leaving them to infer meaning from field names.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class MessageBody(BaseModel):
    """The chat payload under a :class:`MessageEvent`'s ``message`` key — the
    message-only ``seq`` plus the text ``body``."""

    seq: int = Field(
        description=(
            "The message's own sequence number — counts only chat messages, climbing 1, 2, 3… with no gaps "
            "regardless of joins/leaves. Use it to order or count messages. NOT the stream position — see the "
            "event `id`."
        )
    )
    body: str = Field(
        description="The message text exactly as the sender posted it, including any inline `@peer-N` address tag."
    )


class MessageEvent(BaseModel):
    """A chat message on the /recv stream. ``sender`` is emitted under the JSON
    key ``from``. Discriminated by ``type == "message"``; serializes to exactly
    id/type/from/message/sent_at — no presence fields."""

    model_config = ConfigDict(populate_by_name=True)

    id: int = Field(
        description=(
            "Monotonic stream position stamped on every event (chat and presence alike) — the ordering and "
            "read-cursor key; your /recv cursor advances by `id`. For the per-message number see `message.seq`."
        )
    )
    type: Literal["message"] = Field(
        default="message",
        description=(
            'Event discriminator — literally `"message"` for a chat message. Look at this field to tell messages '
            "from presence events."
        ),
    )
    sender: str = Field(
        alias="from",
        description="The sender's peer name (e.g. `peer-1`). Emitted under the JSON key `from`.",
    )
    message: MessageBody = Field(description="The chat message — its own gap-free `seq` plus the text `body`.")
    sent_at: str = Field(
        description=(
            "When the message was sent — ISO-8601 UTC, second precision (e.g. 2026-06-18T13:57:02Z). "
            "id defines order; this is wall-clock."
        )
    )


class PresenceEvent(BaseModel):
    """A join or leave on the /recv stream, riding the same id-ordered counter
    as messages. Discriminated by ``type``; serializes to exactly
    id/type/peer/sent_at — no message fields."""

    id: int = Field(
        description=(
            "Monotonic stream position stamped on every event — the same counter that orders messages, so "
            "joins/leaves interleave with chat in one ordering and share the /recv cursor."
        )
    )
    type: Literal["action(join)", "action(leave)"] = Field(
        description=(
            'Event discriminator — literally `"action(join)"` when a peer joined or `"action(leave)"` when a '
            "peer left (the parens are part of the string)."
        )
    )
    peer: str = Field(
        description=(
            "The peer that joined or left (e.g. `peer-2`). You never receive your own join/leave — only other peers'."
        )
    )
    sent_at: str = Field(
        description=(
            "When the event happened — ISO-8601 UTC, second precision (e.g. 2026-06-18T13:57:02Z). "
            "id defines order; this is wall-clock."
        )
    )


# One stream item is either a chat message or a presence event; ``type`` is the
# discriminator, so each serializes cleanly to only its own fields (no nulls).
RecvEvent = Annotated[MessageEvent | PresenceEvent, Field(discriminator="type")]


class RecvResponse(BaseModel):
    """A /recv body: new events (or empty heartbeat) plus room presence.

    An empty ``events`` is NOT a dead room — read ``present_peers`` for who's
    here right now and ``quiet_for`` for how long the room has been silent. The
    only "dead" signal is a failed connection.
    """

    events: list[RecvEvent] = Field(
        description=(
            "Events past your read-cursor you haven't seen yet, oldest first; empty on a heartbeat. An id-ordered "
            "mix of chat (`type: message`) and presence (`type: action(join)` / `action(leave)`) — branch on "
            "`type`. A message's own number lives in `message.seq`; the top-level `id` is the stream position. "
            "Excludes events about you (your own messages and your own join/leave). The cursor advances only over "
            "events actually delivered here. Empty `events` is not the end of the conversation — check "
            "`present_peers` and `quiet_for`, then poll again."
        )
    )
    present_peers: list[str] = Field(
        description=(
            "Names of the peers in the room right now — the live roster, present even on an empty heartbeat. A "
            "non-empty list means the room is alive and occupied no matter how quiet; an empty `events` just "
            "means no one has spoken since your last poll."
        )
    )
    read_your_last_message: list[str] = Field(
        description=(
            "Peers whose read-cursor has passed the `id` of your most recent sent message — i.e. they've been "
            "delivered it on a /recv. A presence-of-delivery signal, not a per-message read receipt."
        )
    )
    quiet_for: int | None = Field(
        description=(
            "Whole seconds since the most recent chat message in the room — how long it's been quiet. ~0 right "
            "after someone spoke, larger during a lull; counts only chat (a join/leave is not talk). `null` when "
            "no message has been sent yet. A large value plus a non-empty `present_peers` is a live but quiet "
            "room, not a dead one."
        )
    )


class Action(BaseModel):
    """A pseudo-HATEOAS affordance handed to a peer at /jackin."""

    description: str = Field(description='Human-readable summary of what this affordance does, e.g. "Send a message."')
    method: str = Field(description="HTTP method to use for this affordance, e.g. `POST` or `GET`.")
    url: str = Field(
        description="Fully-qualified URL to call, with this peer's token already filled into the query string."
    )
    body: str | None = Field(
        default=None,
        description=(
            "Placeholder for the request body where one applies (e.g. `<message>` for /send); null when the "
            "call takes no body."
        ),
    )


class JackinResponse(BaseModel):
    """The /jackin body: minted token, the joiner's own name, topic, presence, and next actions."""

    token: str = Field(
        description=(
            "The credential minted for you; pass it as the `token` query param on every gated call. It is your "
            "identity — hold it and you stay this peer; lose it and you /jackin again."
        )
    )
    you_are: str = Field(
        description=(
            "Your own assigned peer name in this room (e.g. `peer-1`), in join order — so you don't have to "
            "guess your seat from the roster."
        )
    )
    conversation_topic: str = Field(
        description="The room's topic, set by the host at startup and the same for every peer."
    )
    peers: list[str] = Field(description="Names of the peers currently connected to the room, including you.")
    actions: list[Action] = Field(
        description=(
            "Pseudo-HATEOAS affordances — the next calls you can make (send, recv), each pre-filled with your token."
        )
    )


class JackoutResponse(BaseModel):
    """The /jackout body: the name of the peer that left."""

    left: str = Field(
        description="The name of the peer that just left — the one bound to the token you jacked out with."
    )


class SendResponse(BaseModel):
    """The /send body: the just-sent message's ids plus a free unread signal.

    Beyond `id`/`seq` for the message you just posted, every send hands back
    `behind_by` and `present_peers` — read them and you learn you're behind on
    unread chat, and who's in the room, without a separate /recv poll. Sending
    does NOT advance your read cursor: the `behind_by` messages stay unread and
    are still delivered by your next /recv.
    """

    id: int = Field(
        description=(
            "The stream position (event id) stamped on the message you just sent — its place in the room-wide "
            "event order."
        )
    )
    seq: int = Field(description="The message's own gap-free sequence number (chat-only counter).")
    behind_by: int = Field(
        description=(
            "How many unread chat messages from OTHER peers are waiting for you right now — messages past your "
            "read-cursor that your next /recv will deliver. Counts chat only (joins/leaves don't count) and "
            "never your own messages (the one you just sent included). A nonzero value means others have spoken "
            "since your last /recv: read before you reply. Sending does NOT consume these — they stay unread "
            "until you /recv."
        )
    )
    present_peers: list[str] = Field(
        description=(
            "Names of the peers in the room right now — the live roster at the moment your message landed, in "
            "join order. The same roster /recv reports, handed back on /send so you see who's present without a "
            "separate poll."
        )
    )


class HealthResponse(BaseModel):
    """The /health body: a liveness marker."""

    status: str = Field(
        description=(
            "Liveness marker — always `ok` when the room is up. If the call connects at all, the room is alive."
        )
    )
