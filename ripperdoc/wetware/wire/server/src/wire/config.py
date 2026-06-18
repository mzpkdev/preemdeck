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

    host / port  — where the HTTP layer binds (the core never reads these).
    secret       — the key gating /shard and /jackin.
    topic        — conversation topic, handed to peers on /jackin.
    wait_default — seconds a quiet /recv parks before a heartbeat.
    wait_max     — server-side clamp on a caller-supplied wait.
    """

    host: str
    port: int
    secret: str
    topic: str
    wait_default: int = 30
    wait_max: int = 60
