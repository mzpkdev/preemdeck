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
DEFAULT_EVENT = "UserPromptSubmit"


def read_source(dat_name: str, md_name: str) -> str | None:
    dat = PLUGIN_ROOT / dat_name
    if dat.exists():
        return base64.b64decode(dat.read_bytes()).decode()
    md = PLUGIN_ROOT / md_name
    if md.exists():
        return md.read_text()
    return None


def main() -> int:
    if not GHOST_SENTINEL.exists():
        GHOST_SENTINEL.parent.mkdir(parents=True, exist_ok=True)
        GHOST_SENTINEL.touch()

    content = read_source("pulse.dat", "PULSE.md")
    if not content:
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
