#!/usr/bin/env python3
"""Mode-routing hook — inject the active mode's md file into the model's context.

Wired inline in each host's manifest:
  .claude-plugin/plugin.json   UserPromptSubmit   — Claude
  .codex-plugin/plugin.json    UserPromptSubmit   — Codex
  gemini-extension.json        BeforeAgent        — Gemini

Two lookups, both OS-agnostic (pure pathlib):
  1. preemdeck.json — found by walking up from this script's dir until it turns
     up. Works in-repo and once installed: every host nests the plugin copy
     under its clone root (`~/.claude`, `~/.codex`, `~/.gemini` — see boot.sh),
     and preemdeck.json sits at that root, so it is always an ancestor.
  2. modes/<mode>.md — shipped inside the plugin, resolved relative to this
     script (plugin_root/modes/<mode>.md).

The active mode is the `mode-example` field of preemdeck.json; the matching
modes/<mode>.md body is injected as additionalContext.

  --event <name>  fallback event name when stdin omits `hook_event_name`
                  (default UserPromptSubmit). stdin wins when it carries one.

Always exits 0 — a missing config, missing/empty field, or unknown mode (no
matching md) is a silent no-op (prints `{}`); the host never blocks.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

CONFIG_NAME = "preemdeck.json"
MODE_KEY = "mode-example"
DEFAULT_EVENT = "UserPromptSubmit"
SEARCH_START = Path(__file__).resolve().parent
MODES_DIR = Path(__file__).resolve().parents[1] / "modes"


def find_config(start: Path) -> Path | None:
    """Walk up from `start` (inclusive) toward the filesystem root; first hit wins."""
    for parent in (start, *start.parents):
        candidate = parent / CONFIG_NAME
        if candidate.is_file():
            return candidate
    return None


def select_mode(config: Path) -> str | None:
    """Return the active mode name from the config's `MODE_KEY` field, or None."""
    try:
        data = json.loads(config.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    if isinstance(data, dict):
        mode = data.get(MODE_KEY)
        if isinstance(mode, str) and mode:
            return mode
    return None


def load_mode_text(mode: str) -> str | None:
    """Load `modes/<mode>.md` from the plugin; None if unknown, empty, or unsafe.

    `mode` must be a bare filename stem — anything carrying a path separator or a
    dot-segment is rejected, so a config value can't escape the modes dir.
    """
    if Path(mode).name != mode:
        return None
    md = MODES_DIR / f"{mode}.md"
    if not md.is_file():
        return None
    return md.read_text(encoding="utf-8").strip() or None


def extract_event(argv: list[str]) -> str | None:
    """Return the value following the first `--event` flag, or None."""
    for i, arg in enumerate(argv):
        if arg == "--event" and i + 1 < len(argv):
            return argv[i + 1]
    return None


def main() -> int:
    config = find_config(SEARCH_START)
    if config is None:
        print("{}")
        return 0
    mode = select_mode(config)
    if mode is None:
        print("{}")
        return 0
    text = load_mode_text(mode)
    if text is None:
        print("{}")
        return 0

    event_name = extract_event(sys.argv[1:]) or DEFAULT_EVENT
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
                    "additionalContext": text,
                }
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
