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

Always exits 0 — missing or empty files are silent no-ops; the host never
blocks on this hook. Missing host-tools file substitutes to empty.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EVENT = "UserPromptSubmit"


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
    template_rel, rest = resolve_template_arg(sys.argv[1:])
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
                    "additionalContext": text,
                }
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
