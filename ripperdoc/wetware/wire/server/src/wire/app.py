"""The FastAPI factory and routes.

``create_app(config)`` builds the app, constructs the one :class:`~wire.room.Room`,
stashes room + config on ``app.state`` (where the auth deps read them), and wires
the endpoints. The HTTP layer is thin: it validates credentials, calls the core,
and renames ``sender`` -> ``from`` on the way out. OpenAPI is served at /schema.

A custom :func:`app.openapi` post-processes the generated document so /schema is
honest: it marks the ``secret``/``token`` query params required (they stay
*optional* in the signatures so a missing credential still returns 401, not
FastAPI's auto-422) and the route metadata carries real descriptions and the
401 error contract. The document is built once and cached on
``app.openapi_schema``.
"""

from __future__ import annotations

import asyncio
import contextlib
import signal
from collections.abc import AsyncIterator, Callable
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Query, Request
from fastapi.openapi.utils import get_openapi
from fastapi.responses import JSONResponse, PlainTextResponse

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

# Reusable 401 response doc for the gated routes — surfaces the real error
# contract in /schema, which otherwise shows only the default 422 model. Each
# JSON 401 body is `{"detail": "<prose>", "code": "<code>"}`; the codes named
# here let a peer branch on the failure without parsing the prose.
_SECRET_401 = {
    401: {
        "description": ('Missing or wrong `secret` -> body `{"detail": "invalid secret", "code": "invalid_secret"}`.')
    }
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
}


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
        left = await room.jackout(token)
        return JackoutResponse(left=left)

    @app.post(
        "/send",
        response_model=SendResponse,
        description=(
            "Post a message to the room and get back `{id, seq}` — the event's stream-position "
            "`id` and the message's own gap-free `seq`. The body is raw "
            "plain text (`curl --data-raw 'your message'`), not JSON. Address one peer by "
            "tagging `@peer-N` inline — a plain-text convention the server does not route on; "
            "every peer still receives it. Gated by `token`. Non-blocking."
        ),
        responses=_TOKEN_401,
        openapi_extra=_SEND_REQUEST_BODY,
    )
    async def send(request: Request, token: str = Depends(require_token)) -> SendResponse:
        # Plain text, not JSON: client sends `curl -d 'your message'`.
        raw = await request.body()
        text = raw.decode("utf-8")
        event_id, seq = await room.send(token, text)
        return SendResponse(id=event_id, seq=seq)

    @app.get(
        "/recv",
        response_model=RecvResponse,
        description=(
            "Long-poll for events. Holds the request open up to `wait` seconds, then returns "
            "either your unseen events (as soon as they arrive) or an empty heartbeat — "
            "`events: []` with the live roster — when the window elapses with nothing new. "
            "`events` is a seq-ordered mix of chat (`type: message`) and presence "
            "(`type: action(join)` / `action(leave)`); branch on `type`. You never receive "
            "events about yourself (your own messages or your own join/leave). An empty "
            "heartbeat is not the end of the conversation; poll again. The token is validated "
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
                    "(clamped server-side). Keep it below your curl --max-time so the client "
                    "outlives the hold. A real message still returns the instant it's sent, "
                    "whatever wait is."
                ),
            ),
        ] = None,
    ) -> RecvResponse:
        if wait is not None:
            wait = min(wait, config.wait_max)
        result = await room.recv(token, wait)
        # Build each event from its log entry, per-type, so the JSON is clean:
        # a message emits only seq/type/from/message/sent_at, a presence event
        # only seq/type/peer/sent_at — no null-padding across the union.
        events: list[MessageEvent | PresenceEvent] = []
        for e in result["events"]:
            if isinstance(e, Message):
                events.append(
                    MessageEvent(
                        id=e.id,
                        **{"from": e.sender},
                        message={"seq": e.seq, "body": e.message},
                        sent_at=e.sent_at,
                    )
                )
            else:
                events.append(PresenceEvent(id=e.id, type=e.type, peer=e.peer, sent_at=e.sent_at))
        return RecvResponse(
            events=events,
            peers=result["peers"],
            read_your_last_message=result["read_your_last_message"],
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
