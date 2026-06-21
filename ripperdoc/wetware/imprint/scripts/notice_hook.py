#!/usr/bin/env python3
"""Turn-end dispatch-panel notice via the `systemMessage` channel.

On every turn-end, surfaces render_dispatch.py's idle (empty) JOBS panel to the
user as a host-rendered notice line, distinct from the model's injected context.
It is the visible "dispatch panel" heartbeat — proof the turn-end hook fired.

Wired as a SEPARATE matcher block alongside inject_hook in each manifest, on the
host's turn-end event:
  .claude-plugin/plugin.json   Stop         — Claude
  .codex-plugin/plugin.json    Stop         — Codex
  gemini-extension.json        AfterAgent   — Gemini

Runs render_dispatch.py (resolved as a sibling of this file) with NO args via
`sys.executable`, captures its stdout, and emits it as a top-level
`systemMessage`. If render_dispatch fails or yields empty stdout, falls back to
a non-empty placeholder panel line.

CRITICAL: a turn-end (Stop) hook MUST exit 0 — a non-zero exit blocks the stop
and can loop. So stdin is read and ignored, and ANY internal error is swallowed:
this hook ALWAYS exits 0 and ALWAYS prints a valid `systemMessage` envelope.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

# render_dispatch.py lives next to this script.
RENDER_DISPATCH = Path(__file__).resolve().parent / "render_dispatch.py"

# Non-empty fallback if render_dispatch can't be run or returns nothing.
FALLBACK = "JOBS  ▱  0/0"


def dispatch_panel() -> str:
    """Run render_dispatch.py with no args; return its stdout (stripped).

    Falls back to FALLBACK on any failure or empty output. Never raises.
    """
    try:
        proc = subprocess.run(
            [sys.executable, str(RENDER_DISPATCH)],
            capture_output=True,
            text=True,
            timeout=4,
        )
        panel = proc.stdout.strip("\n")
        if proc.returncode == 0 and panel:
            return panel
    except Exception:
        pass
    return FALLBACK


def main() -> int:
    # Drain and ignore stdin — the payload doesn't shape the notice, but the
    # host may pipe it, and an unread pipe can wedge.
    try:
        sys.stdin.read()
    except Exception:
        pass

    print(json.dumps({"systemMessage": dispatch_panel()}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Never block the host on a turn-end (Stop) hook, even on an
        # unexpected internal error: always exit 0.
        sys.exit(0)
