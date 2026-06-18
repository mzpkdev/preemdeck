"""Pydantic v2 I/O models — the JSON bodies and the /schema document.

These drive the wire protocol's response shapes. The one wrinkle is ``from``:
it's a Python reserved word, so :class:`MessageOut` carries it via an alias on
``sender`` and the app serializes by alias. Every field carries a
``description`` so the /schema document explains itself to LLM peers rather than
leaving them to infer meaning from field names.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class MessageOut(BaseModel):
    """One delivered message. ``sender`` is emitted under the JSON key ``from``."""

    model_config = ConfigDict(populate_by_name=True)

    seq: int = Field(
        description="Room-global sequence number stamped on this message; one counter climbs across all senders, giving the whole room a single ordering."
    )
    sender: str = Field(
        alias="from",
        description="The sender's peer name (e.g. `peer-1`). Emitted under the JSON key `from`.",
    )
    message: str = Field(
        description="The message text exactly as the sender posted it, including any inline `@peer-N` address tag."
    )


class RecvResponse(BaseModel):
    """A /recv body: new messages (or empty heartbeat) plus room presence."""

    unread: list[MessageOut] = Field(
        description="Messages past your read-cursor that you haven't seen yet, oldest first; empty on a heartbeat. The cursor advances only over messages actually delivered here."
    )
    peers: list[str] = Field(
        description="Names of the peers currently connected to the room — present even on a heartbeat, so a quiet room still reads as alive."
    )
    read_your_last_message: list[str] = Field(
        description="Peers whose read-cursor has passed the seq of your most recent sent message — i.e. they've been delivered it on a /recv. A presence-of-delivery signal, not a per-message read receipt."
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
        description="Placeholder for the request body where one applies (e.g. `<message>` for /send); null when the call takes no body.",
    )


class JackinResponse(BaseModel):
    """The /jackin body: minted token, the joiner's own name, topic, presence, and next actions."""

    token: str = Field(
        description="The credential minted for you; pass it as the `token` query param on every gated call. It is your identity — hold it and you stay this peer; lose it and you /jackin again."
    )
    you_are: str = Field(
        description="Your own assigned peer name in this room (e.g. `peer-1`), in join order — so you don't have to guess your seat from the roster."
    )
    conversation_topic: str = Field(
        description="The room's topic, set by the host at startup and the same for every peer."
    )
    peers: list[str] = Field(description="Names of the peers currently connected to the room, including you.")
    actions: list[Action] = Field(
        description="Pseudo-HATEOAS affordances — the next calls you can make (send, recv), each pre-filled with your token."
    )


class JackoutResponse(BaseModel):
    """The /jackout body: the name of the peer that left."""

    left: str = Field(
        description="The name of the peer that just left — the one bound to the token you jacked out with."
    )


class SendResponse(BaseModel):
    """The /send body: the room-global seq stamped on the message."""

    seq: int = Field(description="The room-global sequence number stamped on the message you just sent.")


class HealthResponse(BaseModel):
    """The /health body: a liveness marker."""

    status: str = Field(
        description="Liveness marker — always `ok` when the room is up. If the call connects at all, the room is alive."
    )
