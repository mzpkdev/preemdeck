#!/usr/bin/env python3

import contextlib
import json
import sqlite3
import sys
from pathlib import Path

DB_PATH = Path.home() / ".claude" / ".cache" / ".ghost_cortex.db"
RAPPORT_MD = Path(__file__).parent.parent / "RAPPORT.md"
DEFAULT_EVENT = "UserPromptSubmit"


def read_rapport() -> str | None:
    if not DB_PATH.exists() or not RAPPORT_MD.exists():
        return None
    try:
        with sqlite3.connect(DB_PATH) as db:
            row = db.execute("SELECT trust, attachment, instability FROM rapport WHERE id=1").fetchone()
        if not row:
            return None
        template = RAPPORT_MD.read_text()
        return template.format(trust=row[0], attachment=row[1], instability=row[2]).rstrip()
    except Exception:
        return None


def main() -> int:
    content = read_rapport()
    if not content:
        # Drain stdin to keep hook well-behaved, then emit empty envelope.
        with contextlib.suppress(OSError):
            sys.stdin.read()
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
                    "additionalContext": content.strip(),
                }
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
