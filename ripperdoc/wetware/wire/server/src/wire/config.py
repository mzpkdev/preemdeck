"""Launch configuration for a wire room.

Frozen dataclass — the single anchor every other module reads. Pure stdlib:
imports neither FastAPI nor pydantic, so the core stays unit-testable without
binding a port.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    """Immutable launch args for one room.

    host / port    — where the HTTP layer binds (the core never reads these).
    secret         — the key gating /shard and /jackin.
    topic          — conversation topic, handed to peers on /jackin.
    wait_default   — seconds a quiet /recv parks before a heartbeat.
    wait_max       — server-side clamp on a caller-supplied wait.
    idle_timeout   — seconds of silence before a peer is dropped from the roster
                     (an ``action(leave)`` on the stream); 0 disables idle drop.
                     MUST stay safely larger than ``wait_max`` — a parked /recv
                     holds a peer silent up to ``wait_max``, and ``last_active`` is
                     stamped at recv ENTRY, so a peer re-polling within
                     ``idle_timeout`` always stays alive (Room asserts this).
    sweep_interval — seconds between idle sweeps (how often the reaper runs); the
                     core stores it for the Phase 2 background task. Not read here.
    empty_grace    — seconds the room tolerates an empty roster before it
                     self-closes (default 900 = 15 min); 0 disables empty-room
                     self-close. The countdown is BOOT-ARMED — it runs from room
                     construction, so a room nobody ever joins dies too. The
                     effect is additive with idle drop: a lone silent peer is
                     first idle-dropped after ``idle_timeout``, and only THEN does
                     the empty-room clock start, so it dies at roughly
                     ``idle_timeout + empty_grace``.
    public_url     — operator-declared public base URL (e.g. behind a tunnel:
                     ngrok/cloudflared/tailscale/ssh -R/nginx); when set, every
                     URL a peer reads (/jackin actions, /shard manual) is emitted
                     against it instead of the request/LAN base. None falls back
                     to the request base URL (today's behavior) — wire stays
                     tunnel-agnostic; the operator owns this string.
    """

    host: str
    port: int
    secret: str
    topic: str
    public_url: str | None = None
    wait_default: int = 30
    wait_max: int = 60
    idle_timeout: int = 300
    sweep_interval: int = 15
    empty_grace: int = 900
