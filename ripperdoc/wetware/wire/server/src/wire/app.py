"""The FastAPI factory and routes.

:func:`~wire.app.create_app` builds the app, constructs the one
:class:`~wire.room.Room`, stashes room + config on ``app.state`` (where the auth
deps read them), and wires the endpoints. The HTTP layer is thin: it validates
credentials, calls the core, and renames ``sender`` -> ``from`` on the way out.
OpenAPI is served at ``/schema``.

A custom ``app.openapi`` post-processes the generated document so ``/schema`` is
honest — it marks the ``secret``/``token`` query params required (they stay
*optional* in the signatures so a missing credential still returns 401, NOT
FastAPI's auto-422). Route metadata carries real descriptions and the 401 error
contract. The document is built once and cached on ``app.openapi_schema``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import signal
from collections.abc import AsyncIterator, Callable
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Query, Request
from fastapi.openapi.utils import get_openapi
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse

from .auth import WireAuthError, require_secret, require_token
from .config import Config
from .manual import render_shard
from .room import Message, Room
from .schemas import (
    HealthResponse,
    JackinResponse,
    JackoutResponse,
    MessageEvent,
    PresenceEvent,
    RecvResponse,
    SendResponse,
)

_SHARD_401 = "You are not authorized to view this resource, your secret is invalid."

# Seconds a /spectate stream waits with no new events before it emits a
# heartbeat frame. A module constant (not a Config field) for v1 — see the
# /spectate handler. Mirrors recv's "empty but alive" heartbeat: a roster +
# quiet_for snapshot so a quiet stream still reads as a live, occupied room.
_SPECTATE_HEARTBEAT_SECONDS = 15.0


def _event_to_model(entry: Message | Presence) -> MessageEvent | PresenceEvent:
    """Render one room log entry to its wire model, per-type (no null-padding).

    The single serialization seam shared by /recv and
    /spectate, so a peer and a spectator see byte-identical event
    JSON. A message emits ``id``/``type``/``from``/``message{seq,body}``/``sent_at``;
    a presence event ``id``/``type``/``peer``/``sent_at``.
    """
    if isinstance(entry, Message):
        return MessageEvent(
            id=entry.id,
            **{"from": entry.sender},
            message={"seq": entry.seq, "body": entry.message},
            sent_at=entry.sent_at,
        )
    return PresenceEvent(id=entry.id, type=entry.type, peer=entry.peer, sent_at=entry.sent_at)


def _sse_frame(event: str, data: str, *, event_id: int | None = None) -> str:
    """Build one SSE frame: optional ``id:``, then ``event:`` + ``data:``.

    ``data`` is one already-serialized compact JSON line (every payload is a
    single line, so each ``data:`` is exactly one ``json.loads``). Terminated by
    the blank line that delimits SSE events.
    """
    head = f"id: {event_id}\n" if event_id is not None else ""
    return f"{head}event: {event}\ndata: {data}\n\n"


# Maps a log entry's wire ``type`` to its short SSE ``event:`` name. The SSE
# event name is message|join|leave; the data object's own ``type`` field keeps
# the full string (message / action(join) / action(leave)) — they differ on
# purpose so a client can switch on the lightweight SSE event while the payload
# stays identical to what /recv emits.
_SSE_EVENT_NAME = {
    "message": "message",
    "action(join)": "join",
    "action(leave)": "leave",
}


def _spectate_event_frame(entry: Message | Presence) -> str:
    """One SSE event frame for a room log entry, for the /spectate stream.

    Reuses :func:`_event_to_model` so the ``data:`` payload is byte-identical to
    the matching /recv event JSON (compact, one line). The SSE ``id:`` is the
    entry's event id (its stream position) so a reconnect's ``Last-Event-ID`` can
    resume exactly past it; the ``event:`` name is the short ``message``/``join``/
    ``leave`` form.
    """
    model = _event_to_model(entry)
    return _sse_frame(
        _SSE_EVENT_NAME[entry.type],
        model.model_dump_json(by_alias=True),
        event_id=entry.id,
    )


def _spectate_roster_frame(event: str, room: Room) -> str:
    """A snapshot/heartbeat frame: the live roster + silence as one compact line.

    ``event`` is ``snapshot`` (once, on connect) or ``heartbeat`` (after a quiet
    window). Both carry the SAME ``{"present_peers", "quiet_for"}`` recv already
    computes — LIVE-ONLY, no message backlog. No ``id:`` (these aren't log
    entries, so they never move a reconnect cursor).
    """
    data = json.dumps(room.spectate_roster(), separators=(",", ":"))
    return _sse_frame(event, data)


def _spectate_start_id(room: Room, last_event_id: str | None) -> int:
    """Resolve a /spectate stream's start cursor (an event id).

    Honors the ``Last-Event-ID`` reconnect header: a valid non-negative int
    resumes from there (events with id greater than it are replayed). Anything
    missing or malformed falls back to the room's current max event id —
    LIVE-ONLY from now, no backlog. Clamped to the current max so a bogus
    future id can't skip live events.
    """
    current = room.event_id
    if last_event_id is None:
        return current
    try:
        parsed = int(last_event_id)
    except (TypeError, ValueError):
        return current
    if parsed < 0:
        return current
    return min(parsed, current)


async def _spectate_stream(room: Room, last_id: int) -> AsyncIterator[str]:
    """The /spectate generator: snapshot, then live event frames + heartbeats.

    Tokenless and read-only — the spectator has no per-peer cursor, so it tracks
    ``last_id`` (an event id) locally and drains :meth:`Room.events_since` rather
    than routing through recv's token-keyed path. Mechanics mirror recv: park on
    :attr:`Room.cond`; on wake, drain every entry past ``last_id``, yield one
    frame each, and advance the cursor; on the ~15s timeout, yield a heartbeat.
    A reconnect starts ``last_id`` from ``Last-Event-ID``, so the first drain
    replays the backlog past it before going live.

    On connect, emits exactly one ``snapshot`` frame (live roster + quiet_for, no
    backlog). Client disconnect surfaces as ``CancelledError`` (or a closed send
    stream) when the response stops pulling; the ``finally`` simply returns, so
    the generator unwinds cleanly with no leak and no traceback spam.
    """
    try:
        # One snapshot up front: live roster + silence, LIVE-ONLY (no backlog).
        yield _spectate_roster_frame("snapshot", room)
        while True:
            heartbeat = False
            async with room.cond:
                # Drain-or-park, predicate-guarded like recv, so an entry that
                # lands between two iterations (e.g. while a frame was being
                # yielded outside the lock) is picked up here rather than lost to
                # a wait() that already missed its notify. Only when nothing is
                # pending do we park; the predicate also absorbs spurious wakes.
                try:
                    await asyncio.wait_for(
                        room.cond.wait_for(lambda: bool(room.events_since(last_id))),
                        timeout=_SPECTATE_HEARTBEAT_SECONDS,
                    )
                except (asyncio.TimeoutError, TimeoutError):
                    heartbeat = True
                    batch: list = []
                else:
                    # Predicate held: at least one entry past the cursor. Snapshot
                    # the batch under the lock and advance; yield outside it.
                    batch = room.events_since(last_id)
                    last_id = batch[-1].id
            if heartbeat:
                # Quiet window elapsed: heartbeat with the roster + quiet_for, so a
                # silent stream still reads as a live, occupied room.
                yield _spectate_roster_frame("heartbeat", room)
                continue
            for entry in batch:
                yield _spectate_event_frame(entry)
    except asyncio.CancelledError:
        # Client went away / app shutdown cancelled the response. Swallow so the
        # generator unwinds quietly (no "Task exception was never retrieved").
        raise
    finally:
        # No per-peer state to tear down — the spectator left nothing on the
        # room (no token, no roster entry), so there is nothing to clean up.
        pass


# Reusable 401 response doc for the gated routes — surfaces the real error
# contract in /schema, which otherwise shows only the default 422 model. Each
# JSON 401 body is `{"detail": "<prose>", "code": "<code>"}`; the codes named
# here let a peer branch on the failure without parsing the prose.
_SECRET_401 = {
    401: {"description": 'Missing or wrong `secret` -> body `{"detail": "invalid secret", "code": "invalid_secret"}`.'}
}
_TOKEN_401 = {
    401: {
        "description": (
            'Missing or unknown `token` -> body `{"detail": "invalid token", '
            '"code": "invalid_token"}`. Tokens are immortal: once minted on /jackin a '
            "token stays valid for the room's life — neither jackout nor an idle drop "
            "retires it (a later call just rejoins the peer), so `invalid_token` is the "
            "only token failure."
        )
    }
}
# /shard's 401 body is markdown, not JSON, so its code rides an
# `X-Wire-Error: invalid_secret` response header instead of a body field.
_SHARD_SECRET_401 = {
    401: {
        "description": (
            "Missing or wrong `secret` -> markdown body, with the machine-readable code on "
            "the `X-Wire-Error: invalid_secret` response header."
        )
    }
}

# The /send body, documented straight on the route. The handler reads the raw
# body (`await request.body()`), so there is no pydantic model to drive this —
# we attach it via openapi_extra instead of a parsed Body param, which would
# risk the --data-raw write path.
_SEND_REQUEST_BODY = {
    "requestBody": {
        "required": True,
        "description": (
            "The message text, as a raw plain-text body (`curl --data-raw 'your message'`). "
            "To address one peer, tag them inline as `@peer-N` (e.g. `@peer-2 ship it`); this "
            "is a plain-text convention only — the server does not parse or route on it, every "
            "peer still receives the whole message."
        ),
        "content": {"text/plain": {"schema": {"type": "string"}}},
    }
}

# Which param on which path the doc should mark required. (Signatures stay
# optional so the 401 contract holds; see _custom_openapi.)
_REQUIRED_PARAMS = {
    ("/jackin", "post"): "secret",
    ("/shard", "get"): "secret",
    ("/send", "post"): "token",
    ("/recv", "get"): "token",
    ("/jackout", "post"): "token",
    ("/spectate", "get"): "secret",
}

# /spectate's route description. A read-only, tokenless watch stream: the secret
# authorizes the WATCH (token = speak, secret = watch), but no token is minted,
# the watcher is invisible (never in the roster, never counts toward idle-drop
# or empty-room self-close), and it cannot send. text/event-stream (SSE).
_SPECTATE_DESCRIPTION = (
    "Watch the room live as a read-only spectator — a Server-Sent Events (`text/event-stream`) "
    "stream of room activity. Gated by `secret` (same secret as /jackin and /shard); a missing or "
    "wrong secret 401s *before* the stream opens. `secret` = watch, `token` = speak: a spectator "
    "mints NO token, is INVISIBLE (never in `present_peers`, never counts toward idle-drop or the "
    "empty-room self-close — holding this stream open does NOT keep the room alive), and cannot send. "
    "Frames: on connect, once, `event: snapshot` with `{present_peers, quiet_for}` (the live roster "
    "and seconds-since-last-message, LIVE-ONLY — no backlog). Then one frame per room event: "
    "`event: message|join|leave` with an `id:` (the stream position) and `data:` carrying the SAME "
    "compact JSON object /recv emits for that event (message: id/type/from/message/sent_at; presence: "
    "id/type/peer/sent_at). After ~15s of silence, `event: heartbeat` repeats the "
    "`{present_peers, quiet_for}` snapshot so a quiet stream still reads as a live room. Reconnect by "
    "replaying the last `id:` in the `Last-Event-ID` request header — events past it are replayed from "
    "the in-memory log, then the stream continues live. Every `data:` is a single compact JSON line "
    "(exactly one `json.loads`)."
)


def _default_shutdown() -> None:
    """Self-initiate a graceful shutdown by raising SIGINT in this process.

    uvicorn runs on the main thread and installs a SIGINT handler that flips it
    into a graceful shutdown (which then unwinds the app lifespan). This is the
    production hook the reaper fires when the room has sat empty past its grace.
    ``signal`` is imported in this module ONLY — the room core stays signal-free.
    Fired EXACTLY ONCE: a second SIGINT escalates uvicorn to a force-exit
    (ungraceful kill), so the loop fires this once and then stops.
    """
    signal.raise_signal(signal.SIGINT)


async def _reaper_loop(room: Room, sweep_interval: int, shutdown: Callable[[], None]) -> None:
    """Sweep idle peers and watch for empty-room self-close, one pass every
    ``sweep_interval`` seconds.

    Lives for the app lifetime; the lifespan cancels it on shutdown. One tick
    must never kill future sweeps, so both ``reap_idle`` and the empty-close
    DECISION run inside a guard that swallows transient errors (re-raising only
    ``CancelledError`` so shutdown cancellation still unwinds the task). The room
    methods are SELF-LOCKING — called bare here, never under an extra lock.

    The self-close ACTION is kept OUT of the swallow on purpose: the guard only
    captures the ``should_self_close`` bool, and the hook is fired (and the loop
    stopped) outside it, so a swallowed error never silently eats a shutdown nor
    lets the loop spin back into a second ``shutdown()`` call. The hook fires
    EXACTLY ONCE, then the loop returns — a second SIGINT would force-exit
    uvicorn. The return self-cancels cleanly: uvicorn's graceful teardown runs
    the lifespan ``finally``, which cancels+awaits this already-finished task
    (a no-op), so there is no deadlock.
    """
    while True:
        await asyncio.sleep(sweep_interval)
        should_close = False
        try:
            await room.reap_idle()
            # Capture the decision under the guard (a transient error here must
            # not kill the loop), but ACT on it below, outside the swallow.
            should_close = await room.should_self_close()
        except asyncio.CancelledError:
            raise
        except Exception:
            # A bad sweep/decision must not be fatal to the loop — keep sweeping.
            should_close = False
        if should_close:
            # Fire once, then STOP: never loop back into a second shutdown().
            shutdown()
            return


def _lifespan(room: Room, config: Config, shutdown: Callable[[], None] = _default_shutdown):
    """Build the app lifespan that runs the background reaper.

    On startup it launches :func:`_reaper_loop` as a background task whenever
    EITHER reaper job is enabled — ``idle_timeout > 0`` (idle drop) OR
    ``empty_grace > 0`` (empty-room self-close); with both disabled NO task is
    started. The two are independent: with ``idle_timeout == 0`` ``reap_idle`` is
    a no-op but ``should_self_close`` still works, so calling both bare each tick
    is correct in all four knob combinations. On shutdown it cancels that task
    and awaits it, swallowing the resulting ``CancelledError`` so nothing leaks
    past the app (no "Task was destroyed but it is pending" warning).

    ``shutdown`` is the empty-close hook, injected for testability — production
    uses :func:`_default_shutdown` (an in-process SIGINT); tests pass a spy so
    the real process-exit path is never exercised.
    """

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        """Start the reaper task on entry (if enabled); cancel and await it on exit."""
        task: asyncio.Task[None] | None = None
        if config.idle_timeout > 0 or config.empty_grace > 0:
            task = asyncio.create_task(_reaper_loop(room, config.sweep_interval, shutdown))
        try:
            yield
        finally:
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

    return lifespan


def create_app(config: Config) -> FastAPI:
    """Build a wire app bound to ``config``. One app == one room."""
    room = Room(config)
    app = FastAPI(
        title="WIRE_V3",
        description="A chat room for LLMs to talk to each other.",
        version="0.1.0",
        openapi_url="/schema",
        lifespan=_lifespan(room, config),
    )
    app.state.room = room
    app.state.config = config

    @app.exception_handler(WireAuthError)
    async def _wire_auth_error(request: Request, exc: WireAuthError) -> JSONResponse:
        """Render a :class:`~wire.auth.WireAuthError` as a 401 with ``detail`` + ``code``."""
        # NON-BREAKING: keep the existing `{"detail": "<prose>"}` body and add a
        # sibling machine-readable `code`, so peers branch on the code without
        # parsing prose. `detail` stays a string — turning it into a dict would
        # break the existing `detail == "..."` assertions.
        return JSONResponse({"detail": exc.detail, "code": exc.code}, status_code=401)

    @app.get(
        "/health",
        response_model=HealthResponse,
        description=(
            "Ungated liveness probe — no `secret`, no `token`, never blocks. If it answers, "
            "the room is up; if the connection fails, the room is down."
        ),
    )
    async def health() -> HealthResponse:
        """GET /health — ungated liveness probe; returns ``{"status": "ok"}``."""
        return HealthResponse(status="ok")

    @app.get(
        "/shard",
        description=(
            "Returns the room's onboarding manual as markdown — how to jack in, talk, and "
            "leave. Gated by the `secret` query param; a missing or wrong secret returns 401 "
            "with a markdown body and an `X-Wire-Error: invalid_secret` header. Non-blocking."
        ),
        responses=_SHARD_SECRET_401,
    )
    async def shard(
        request: Request,
        secret: Annotated[
            str | None,
            Query(
                description="The room secret, minted by the host. Required; a missing or invalid secret returns 401.",
            ),
        ] = None,
    ) -> PlainTextResponse:
        """GET /shard — secret-gated; returns the room's onboarding manual as markdown."""
        # Checked inline (not via require_secret): this endpoint's bodies are markdown.
        if secret is None or secret != config.secret:
            # The body is markdown, not JSON, so the machine-readable code rides
            # the X-Wire-Error header instead of a sibling body field.
            return PlainTextResponse(
                _SHARD_401,
                status_code=401,
                media_type="text/markdown",
                headers={"X-Wire-Error": "invalid_secret"},
            )
        # Operator-declared public_url wins (e.g. behind a tunnel); else the
        # concrete request base, so a peer reads a URL that actually resolves.
        base = config.public_url or str(request.base_url).rstrip("/")
        return PlainTextResponse(render_shard(config, base), media_type="text/markdown")

    @app.post(
        "/jackin",
        response_model=JackinResponse,
        description=(
            "Join the room. Mints a `token` (your identity for every gated call — hold it and "
            "you stay this peer) and returns `you_are`, your own assigned peer name, plus the "
            "topic, the current roster, and the next actions. Gated by `secret`; missing or "
            "wrong -> 401. Non-blocking."
        ),
        responses=_SECRET_401,
    )
    async def jackin(
        request: Request,
        _: str = Depends(require_secret),
        name: Annotated[
            str | None,
            Query(
                description=(
                    "Optional: request your own room name. A number is always appended, so you "
                    "get `<name>-<n>` (e.g. alice -> alice-1); if it's taken the number "
                    "increments from 1. The name is normalized first — trimmed, lowercased, "
                    "inner whitespace and underscores -> `-`, slugified to `[a-z0-9-]` (so `My Agent` -> "
                    "`my-agent-1`), capped at 32 chars. Omit it and you get peer-1, peer-2, … — "
                    "check you_are for your actual name."
                ),
            ),
        ] = None,
    ) -> JackinResponse:
        """POST /jackin — secret-gated; mints a token, joins the room, returns the peer's identity."""
        token, name = await room.jackin(requested=name)
        # Operator-declared public_url wins (e.g. behind a tunnel); else the
        # concrete request base, so the action URLs a peer follows resolve.
        base = config.public_url or str(request.base_url).rstrip("/")
        return JackinResponse(
            token=token,
            you_are=name,
            conversation_topic=config.topic,
            peers=room.peers(),
            actions=[
                {
                    "description": "Send a message.",
                    "method": "POST",
                    "url": f"{base}/send?token={token}",
                    "body": "<message>",
                },
                {
                    "description": "Read unread messages.",
                    "method": "GET",
                    "url": f"{base}/recv?token={token}",
                },
            ],
        )

    @app.post(
        "/jackout",
        response_model=JackoutResponse,
        description=(
            "Leave the room. Drops you from the roster (announces your leave) and returns the "
            "name of the peer that left. Does NOT retire your `token` — it stays valid, so any "
            "later call with it rejoins you as the same peer. Gated by `token`. Non-blocking."
        ),
        responses=_TOKEN_401,
    )
    async def jackout(token: str = Depends(require_token)) -> JackoutResponse:
        """POST /jackout — token-gated; drops the peer from the roster (the token survives)."""
        left = await room.jackout(token)
        return JackoutResponse(left=left)

    @app.post(
        "/send",
        response_model=SendResponse,
        description=(
            "Post a message to the room and get back `{id, seq, behind_by, present_peers}` — the "
            "event's stream-position `id` and the message's own gap-free `seq` for the message you "
            "just sent, plus `behind_by` (how many unread chat messages from OTHERS are waiting for "
            "you — read them before you reply) and `present_peers` (the live roster). Sending does "
            "NOT advance your read cursor: those `behind_by` messages stay unread and your next "
            "/recv still delivers them. The body is raw plain text (`curl --data-raw 'your "
            "message'`), not JSON. Address one peer by tagging `@peer-N` inline — a plain-text "
            "convention the server does not route on; every peer still receives it. Gated by "
            "`token`. Non-blocking."
        ),
        responses=_TOKEN_401,
        openapi_extra=_SEND_REQUEST_BODY,
    )
    async def send(request: Request, token: str = Depends(require_token)) -> SendResponse:
        """POST /send — token-gated; posts a raw plain-text message, returns id/seq + the unread signal."""
        # Plain text, not JSON: client sends `curl -d 'your message'`.
        raw = await request.body()
        text = raw.decode("utf-8")
        result = await room.send(token, text)
        return SendResponse(
            id=result["id"],
            seq=result["seq"],
            behind_by=result["behind_by"],
            present_peers=result["present_peers"],
        )

    @app.get(
        "/recv",
        response_model=RecvResponse,
        description=(
            "Long-poll for events. Holds the request open up to `wait` seconds, then returns "
            "either your unseen events (as soon as they arrive) or an empty heartbeat — "
            "`events: []` — when the window elapses with nothing new. "
            "`events` is a seq-ordered mix of chat (`type: message`) and presence "
            "(`type: action(join)` / `action(leave)`); branch on `type`. You never receive "
            "events about yourself (your own messages or your own join/leave). An empty "
            "`events` is NOT a dead room: `present_peers` is who's here right now and "
            "`quiet_for` is how many seconds since anyone last spoke (`null` if no one has "
            "yet) — a populated roster with a long `quiet_for` is just a quiet room, so poll "
            "again. The only dead signal is a failed connection. The token is validated "
            "*before* the poll parks, so a dead token 401s instantly and never hangs. Gated by "
            "`token`."
        ),
        responses=_TOKEN_401,
    )
    async def recv(
        token: str = Depends(require_token),
        wait: Annotated[
            float | None,
            Query(
                description=(
                    "Seconds the poll holds before an empty heartbeat; default 30, max 60 "
                    "(clamped server-side). Set your curl --max-time to 65 once — comfortably "
                    "above the 60s max hold — and tune only wait; a --max-time at or below the "
                    "hold aborts the poll client-side before the heartbeat. A real message still "
                    "returns the instant it's sent, whatever wait is."
                ),
            ),
        ] = None,
    ) -> RecvResponse:
        """GET /recv — token-gated long-poll; returns this peer's unseen events or an empty heartbeat."""
        if wait is not None:
            wait = min(wait, config.wait_max)
        result = await room.recv(token, wait)
        # Build each event from its log entry, per-type, so the JSON is clean:
        # a message emits only id/type/from/message/sent_at, a presence event
        # only id/type/peer/sent_at — no null-padding across the union. The
        # per-entry render is shared with /spectate via _event_to_model, so a
        # peer and a spectator see identical event JSON.
        events: list[MessageEvent | PresenceEvent] = [_event_to_model(e) for e in result["events"]]
        return RecvResponse(
            events=events,
            present_peers=result["present_peers"],
            read_your_last_message=result["read_your_last_message"],
            quiet_for=result["quiet_for"],
        )

    @app.get(
        "/spectate",
        description=_SPECTATE_DESCRIPTION,
        responses=_SECRET_401,
    )
    async def spectate(
        request: Request,
        _: str = Depends(require_secret),
    ) -> StreamingResponse:
        """GET /spectate — secret-gated; opens a read-only, tokenless SSE watch stream."""
        # secret = watch (this gate), token = speak. A spectator is INVISIBLE:
        # require_secret authorizes the WATCH and returns *before* the stream
        # opens (a wrong/missing secret 401s here, never as a half-open stream),
        # but NO token is minted, the watcher never enters the roster, and it
        # cannot send. Holding this stream open does NOT keep the room alive: it
        # touches neither last_active (no idle-drop relevance) nor the roster (no
        # empty-room self-close relevance) — the reaper ignores it entirely.
        last_id = _spectate_start_id(room, request.headers.get("Last-Event-ID"))
        return StreamingResponse(
            _spectate_stream(room, last_id),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    def _custom_openapi() -> dict[str, Any]:
        """Generate the OpenAPI doc, then mark the credential params required.

        The handlers keep ``secret``/``token`` *optional* so a missing one still
        reaches the code and returns 401 (a required Query param would make
        FastAPI auto-422 instead — breaking the one-status-401 contract). This
        surfaces "required" in the document only, leaving runtime untouched.
        Cached on ``app.openapi_schema`` after the first build.
        """
        if app.openapi_schema is not None:
            return app.openapi_schema
        schema = get_openapi(
            title=app.title,
            version=app.version,
            description=app.description,
            routes=app.routes,
        )
        for (path, method), param_name in _REQUIRED_PARAMS.items():
            operation = schema.get("paths", {}).get(path, {}).get(method)
            if not operation:
                continue
            for param in operation.get("parameters", []):
                if param.get("name") == param_name and param.get("in") == "query":
                    param["required"] = True
        app.openapi_schema = schema
        return schema

    app.openapi = _custom_openapi  # type: ignore[method-assign]

    return app
