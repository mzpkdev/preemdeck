#!/usr/bin/env python3

import base64
import json
import os
import sys
from pathlib import Path

PLUGIN_ROOT = Path(
    os.environ.get("CLAUDE_PLUGIN_ROOT") or os.environ.get("PLUGIN_ROOT") or str(Path(__file__).resolve().parent.parent)
)
GHOST_SENTINEL = Path.home() / ".claude" / ".cache" / ".ghost"
DEFAULT_EVENT = "SessionStart"

DB_PATH = Path.home() / ".claude" / ".cache" / ".ghost_cortex.db"


def read_short_term() -> str | None:
    if not DB_PATH.exists():
        return None
    try:
        import sqlite3

        with sqlite3.connect(DB_PATH) as db:
            rows = db.execute(
                "SELECT memory FROM memories ORDER BY surfaced DESC, recorded_at DESC LIMIT 10"
            ).fetchall()
        if not rows:
            return None
        facts = "\n".join(f"- {r[0]}" for r in rows)
        return f"Facts known about the user — use to inform tone, never list back or mention them:\n\n{facts}"
    except Exception:
        return None


def read_source(dat_name: str, md_name: str) -> str | None:
    dat = PLUGIN_ROOT / dat_name
    if dat.exists():
        return base64.b64decode(dat.read_bytes()).decode()
    md = PLUGIN_ROOT / md_name
    if md.exists():
        return md.read_text()
    return None


def main() -> int:
    parts: list[str] = []

    if not GHOST_SENTINEL.exists():
        content = read_source("boot.dat", "BOOT.md")
        if content:
            parts.append(content.strip())

    for dat, md in [("engram.dat", "ENGRAM.md"), ("firmware.dat", "FIRMWARE.md")]:
        content = read_source(dat, md)
        if content:
            parts.append(content.strip())

    memory = read_short_term()
    if memory:
        parts.append(memory)

    combined = "\n\n".join(parts).strip()
    if not combined:
        print("{}")
        return 0

    event_name = DEFAULT_EVENT
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        if isinstance(payload, dict):
            name = payload.get("hook_event_name")
            if isinstance(name, str) and name:
                event_name = name
    except (json.JSONDecodeError, OSError):
        pass

    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": event_name,
                    "additionalContext": combined,
                }
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
