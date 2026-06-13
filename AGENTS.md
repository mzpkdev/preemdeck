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

## Applying changes to ~/.claude

Editing this repo does **not** update a running harness. `~/.claude` is its own preemdeck clone; plugins install as a
**pinned copy** under `~/.claude/plugins/cache/`, not a symlink — so an edit here stays invisible until that clone is
pulled and the CLI restarts.

**User-gated: after modifying preemdeck, never apply it to ~/.claude yourself — surface it and ask the user to run it.**
Both installers are destructive by design: `update.py` does `git reset --hard` (discards uncommitted work in the
target), and `install.py`'s `.trash` step deletes `AGENTS.md`, `scripts/`, `tests/`, `pyproject.toml`, etc. — it's a
one-shot bootstrap for a throwaway clone, not the dev repo.

Canonical flow — hand these to the user, don't run them:

```bash
git -C ~/preemdeck add -A && git commit -m "…" && git push   # 1. dev repo: commit + push
cd ~/.claude && python3 update.py                            # 2. deployed clone: pull + re-install
```

Then restart the host CLI — plugins load at startup.

## Agents

See [`llm-docs/INDEX.md`](llm-docs/INDEX.md) for the full working references (Claude↔Codex↔Gemini, coding standards,
contribution guide, how-to-create agents/hooks/skills).
