#!/usr/bin/env python3
"""Context-injection hook — inject an imprint template with host-specific tooling info.

Wired inline in each host's manifest:
  .claude-plugin/plugin.json   UserPromptSubmit + SessionStart   — Claude
  .codex-plugin/plugin.json    UserPromptSubmit + SessionStart   — Codex
  gemini-extension.json        BeforeAgent      + SessionStart   — Gemini

Args (positional, backwards-compatible):
  argv[1] — prompt template path (relative to plugin root) OR `--file <name>`
            where <name> is a short alias (`imprint`, `visuals`) that maps to
            `<NAME>.md` in the plugin root
  argv[2] — host-tools file path (relative to plugin root); contents replace
            `{{host_tools}}` in the template. Optional — templates without the
            placeholder (e.g. VISUALS.md) ignore it.

Examples:
  inject_hook.py IMPRINT.md hosts/host_claude.md         # legacy positional
  inject_hook.py --file imprint hosts/host_claude.md     # equivalent via alias
  inject_hook.py --file visuals                          # static template, no host-tools

The hook reads `hook_event_name` from the JSON payload on stdin and echoes it
back in the envelope, so the same script works for any context-injection event
(SessionStart, UserPromptSubmit, BeforeAgent, …) without code changes — each
manifest is the only place that knows which event to wire.

  --event <name>  fallback event name when stdin omits `hook_event_name`
                  (default `UserPromptSubmit`). stdin always wins when it
                  carries a non-empty `hook_event_name`. Lets each manifest
                  declare the right label for its wiring (e.g. SessionStart,
                  BeforeAgent) instead of silently defaulting.

Always exits 0 — missing or empty files are silent no-ops; the host never
blocks on this hook. Missing host-tools file substitutes to empty.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EVENT = "UserPromptSubmit"


def extract_event_arg(argv: list[str]) -> tuple[str | None, list[str]]:
    """Pull `--event <name>` out of argv; return (event_or_None, remaining_argv).

    Extracted before template resolution so positional/`--file` parsing sees
    argv with the flag already removed. Only the first `--event` is honored.
    """
    out: list[str] = []
    event: str | None = None
    i = 0
    while i < len(argv):
        if argv[i] == "--event" and event is None:
            if i + 1 < len(argv):
                event = argv[i + 1]
                i += 2
                continue
            i += 1
            continue
        out.append(argv[i])
        i += 1
    return event, out


def resolve_template_arg(argv: list[str]) -> tuple[str | None, list[str]]:
    """Resolve argv[1] into a template path; return (path, remaining_argv).

    Supports two forms:
      --file <name>   → <NAME>.md (alias for short-name invocation)
      <path>          → used verbatim (legacy positional)
    """
    if not argv:
        return None, []
    if argv[0] == "--file":
        if len(argv) < 2:
            return None, []
        return f"{argv[1].upper()}.md", argv[2:]
    return argv[0], argv[1:]


def main() -> int:
    cli_event, argv = extract_event_arg(sys.argv[1:])
    template_rel, rest = resolve_template_arg(argv)
    if template_rel is None:
        return 0

    prompt_path = PLUGIN_ROOT / template_rel
    if not prompt_path.is_file():
        return 0
    template = prompt_path.read_text(encoding="utf-8")

    host_tools = ""
    if rest:
        host_path = PLUGIN_ROOT / rest[0]
        if host_path.is_file():
            host_tools = host_path.read_text(encoding="utf-8").strip()

    text = template.replace("{{host_tools}}", host_tools).strip()
    if not text:
        return 0

    default_event = cli_event or DEFAULT_EVENT
    event_name = default_event
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
