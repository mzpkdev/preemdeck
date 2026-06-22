#!/usr/bin/env python3
"""Directive-routing hook — inject the active modes' directive bodies into context.

Wired inline in each host's manifest:
  .claude-plugin/plugin.json   UserPromptSubmit   — Claude
  .codex-plugin/plugin.json    UserPromptSubmit   — Codex
  gemini-extension.json        BeforeAgent        — Gemini

Each mode is a skill folder: skills/<value>/ holds SKILL.md (the user-invocable
setter — running it writes this mode into preemdeck.json) and directive.md (the
prose this hook injects). The two are split so the setter instructions never
leak into the injected context.

Two lookups, both OS-agnostic (pure pathlib):
  1. preemdeck.json — found by walking up from this script's dir until it turns
     up. Works in-repo and once installed: every host nests the plugin copy
     under its clone root (`~/.claude`, `~/.codex`, `~/.gemini` — see boot.sh),
     and preemdeck.json sits at that root, so it is always an ancestor.
  2. skills/<value>/directive.md — shipped inside the plugin, resolved relative
     to this script (plugin_root/skills/<value>/directive.md).

The `directive` field of preemdeck.json is an object of slots, each naming the
active value for that slot, e.g.:

    "directive": { "strategy": "swarm", "discretion": "auto" }

Every slot's value is resolved to its directive.md body and the bodies are
concatenated (slot order, deduped) into one additionalContext block. A bare
string is also accepted as a single value (legacy single-select).

  --event <name>  fallback event name when stdin omits `hook_event_name`
                  (default UserPromptSubmit). stdin wins when it carries one.

Always exits 0 — a missing config, empty directive, or values with no matching
directive.md are a silent no-op (prints `{}`); the host never blocks.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

CONFIG_NAME = "preemdeck.json"
DIRECTIVE_KEY = "directive"
DEFAULT_EVENT = "UserPromptSubmit"
SEARCH_START = Path(__file__).resolve().parent
SKILLS_DIR = Path(__file__).resolve().parents[1] / "skills"


def find_config(start: Path) -> Path | None:
    """Walk up from `start` (inclusive) toward the filesystem root; first hit wins."""
    for parent in (start, *start.parents):
        candidate = parent / CONFIG_NAME
        if candidate.is_file():
            return candidate
    return None


def select_variants(config: Path) -> list[str]:
    """Active values from the config's `directive` field, in slot order, deduped.

    `directive` is an object {slot: value}; its non-empty string values are the
    active values. A bare string is accepted as a single value. Anything else
    yields an empty list.
    """
    try:
        data = json.loads(config.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    if not isinstance(data, dict):
        return []
    field = data.get(DIRECTIVE_KEY)
    if isinstance(field, str):
        values: list[object] = [field]
    elif isinstance(field, dict):
        values = list(field.values())
    else:
        return []
    out: list[str] = []
    for v in values:
        if isinstance(v, str) and v and v not in out:
            out.append(v)
    return out


def load_mode_text(value: str) -> str | None:
    """Load `skills/<value>/directive.md`; None if unknown, empty, or unsafe.

    `value` must be a bare name — anything carrying a path separator or a
    dot-segment is rejected, so a config value can't escape the skills dir.
    """
    if Path(value).name != value:
        return None
    body = SKILLS_DIR / value / "directive.md"
    if not body.is_file():
        return None
    return body.read_text(encoding="utf-8").strip() or None


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
    bodies = [t for t in (load_mode_text(v) for v in select_variants(config)) if t]
    if not bodies:
        print("{}")
        return 0
    text = "\n\n".join(bodies)

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
