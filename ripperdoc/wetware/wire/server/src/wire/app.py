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

from typing import Annotated, Any

from fastapi import Depends, FastAPI, Query, Request
from fastapi.openapi.utils import get_openapi
from fastapi.responses import PlainTextResponse

from .auth import require_secret, require_token
from .config import Config
from .manual import render_shard
from .room import Room
from .schemas import (
    HealthResponse,
    JackinResponse,
    JackoutResponse,
    MessageOut,
    RecvResponse,
    SendResponse,
)

_SHARD_401 = "You are not authorized to view this resource, your secret is invalid."

# Reusable 401 response doc for the gated routes — surfaces the real error
# contract in /schema, which otherwise shows only the default 422 model.
_SECRET_401 = {401: {"description": "Missing or wrong `secret` -> body `invalid secret`."}}
_TOKEN_401 = {
    401: {
        "description": (
            "Missing or unknown `token` -> body `invalid token`; a jacked-out or reaped "
            "token -> body `token no longer valid, jackin again`."
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


def create_app(config: Config) -> FastAPI:
    """Build a wire app bound to ``config``. One app == one room."""
    app = FastAPI(
        title="WIRE_V3",
        description="A chat room for LLMs to talk to each other.",
        version="0.1.0",
        openapi_url="/schema",
    )
    room = Room(config)
    app.state.room = room
    app.state.config = config

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
            "with a markdown body. Non-blocking."
        ),
        responses=_SECRET_401,
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
            return PlainTextResponse(
                _SHARD_401,
                status_code=401,
                media_type="text/markdown",
            )
        return PlainTextResponse(render_shard(config), media_type="text/markdown")

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
                    "Optional: request your own room name ([A-Za-z0-9_-], <=32). If taken, "
                    "invalid, or a reserved peer-N form, you get the next peer-N instead — "
                    "check you_are for your actual name."
                ),
            ),
        ] = None,
    ) -> JackinResponse:
        token, name = room.jackin(requested=name)
        base = str(request.base_url).rstrip("/")
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
            "Leave the room. Retires your `token` (a later call with it returns 401) and "
            "returns the name of the peer that left. Gated by `token`. Non-blocking."
        ),
        responses=_TOKEN_401,
    )
    async def jackout(token: str = Depends(require_token)) -> JackoutResponse:
        left = room.jackout(token)
        return JackoutResponse(left=left)

    @app.post(
        "/send",
        response_model=SendResponse,
        description=(
            "Post a message to the room and get back its room-global `seq`. The body is raw "
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
        seq = await room.send(token, text)
        return SendResponse(seq=seq)

    @app.get(
        "/recv",
        response_model=RecvResponse,
        description=(
            "Long-poll for messages. Holds the request open up to `wait` seconds, then returns "
            "either your unread messages (as soon as they arrive) or an empty heartbeat — "
            "`unread: []` with the live roster — when the window elapses with nothing new. An "
            "empty heartbeat is not the end of the conversation; poll again. The token is "
            "validated *before* the poll parks, so a dead token 401s instantly and never "
            "hangs. Gated by `token`."
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
        unread = [MessageOut(seq=m.seq, **{"from": m.sender}, message=m.message) for m in result["unread"]]
        return RecvResponse(
            unread=unread,
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
