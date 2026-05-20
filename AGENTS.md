## Prerequisites

- Python 3.12+
- pip3
- uv

Bootstrap:

- `uv sync`

## Format on edit

A project-local hook runs `ruff format` (`.py`) and `mdformat` (`.md`) after every agent edit on Claude Code, Codex, and
Gemini CLI. It never blocks the edit — failures warn on stderr.

| File                        | Role                                    |
| --------------------------- | --------------------------------------- |
| `scripts/format_on_edit.py` | Shared script — single source of truth  |
| `.claude/settings.json`     | Claude: `PostToolUse` → script          |
| `.codex/config.toml`        | Codex: `[[hooks.PostToolUse]]` → script |
| `.gemini/settings.json`     | Gemini: `AfterTool` → script            |

**Codex trust:** first run prompts you to trust the project — accept it, or `.codex/config.toml` is silently ignored.
(Alt: pre-add `[projects."/abs/path/to/preemdeck"] trust_level = "trusted"` to `~/.codex/config.toml`.)

Full-repo format pass: `uv run task format`.

## Agents

See [`llm-docs/INDEX.md`](llm-docs/INDEX.md) for the full working references (Claude↔Codex↔Gemini, coding standards,
contribution guide, how-to-create agents/hooks/skills).
