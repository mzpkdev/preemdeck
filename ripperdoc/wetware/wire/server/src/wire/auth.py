"""FastAPI auth dependencies — the one-status-401 contract.

Every gated endpoint rejects a missing, wrong, or dead credential with HTTP
401; the body names the failed key and what to do. The room and config are
reached through ``request.app.state`` (wired in :func:`wire.app.create_app`).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import HTTPException, Query, Request

from .config import Config
from .room import Room, TokenStatus

# Kept OPTIONAL (default None) on purpose: a missing credential must reach the
# handler and return 401, not trip FastAPI's auto-422 for a required param. The
# doc marks them required via the custom app.openapi() in wire.app — runtime
# behaviour is unchanged.
_SECRET_QUERY = Query(
    description="The room secret, minted by the host. Required; a missing or invalid secret returns 401 `invalid secret`.",
)
_TOKEN_QUERY = Query(
    description="Your peer token from /jackin. Required; missing or unknown returns 401 `invalid token`, a jacked-out/reaped token returns 401 `token no longer valid, jackin again`.",
)


def _room(request: Request) -> Room:
    return request.app.state.room


def _config(request: Request) -> Config:
    return request.app.state.config


def require_secret(request: Request, secret: Annotated[str | None, _SECRET_QUERY] = None) -> str:
    """Gate on the ``secret`` query param. Missing or wrong -> 401.

    Used by /jackin. (/shard checks the secret itself because its bodies are
    markdown, not the JSON this raises.)
    """
    if secret is None or secret != _config(request).secret:
        raise HTTPException(status_code=401, detail="invalid secret")
    return secret


def require_token(request: Request, token: Annotated[str | None, _TOKEN_QUERY] = None) -> str:
    """Gate on the ``token`` query param via the room's three-way verdict.

    UNKNOWN / missing -> 401 "invalid token";
    DEAD              -> 401 "token no longer valid, jackin again";
    VALID             -> returns the token.

    Used by /recv, /send, /jackout. As a FastAPI dependency it runs *before*
    the route body, so /recv validates before parking its long-poll — a dead
    token 401s instantly and never hangs.
    """
    room = _room(request)
    if token is None:
        raise HTTPException(status_code=401, detail="invalid token")
    status = room.status(token)
    if status is TokenStatus.VALID:
        return token
    if status is TokenStatus.DEAD:
        raise HTTPException(status_code=401, detail="token no longer valid, jackin again")
    raise HTTPException(status_code=401, detail="invalid token")
