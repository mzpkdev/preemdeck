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

## Tests

- Repo-level suite (root `tests/`): `uv run pytest` from the repo root — what CI runs.
- Wire server suite (`ripperdoc/wetware/wire/server/tests/`, 202 tests):
  `cd ripperdoc/wetware/wire/server && uv run pytest`. uv resolves the `wire` workspace member and auto-syncs its `dev`
  group (pytest, pytest-asyncio, httpx) into the shared `.venv`. The `wire:start`/`wire:stop` runtime path uses
  `uv run --no-sync wire …` and is unaffected.

## Applying changes to a running harness

preemdeck's source lives in its own dir, `~/.preemdeck` — it does **not** squat `~/.claude` / `~/.codex` / `~/.gemini`.
The installer registers marketplaces/plugins by absolute path back into `~/.preemdeck` and **copies** the per-harness
overlay (`root/<harness>/` — settings + the `fixer` agent) into the host config dir, backing up any clobbered file once
to `<file>.bak`. So editing this repo does **not** update a running harness: overlay edits need a re-install to copy out
again, and any edit only takes effect after the host CLI restarts.

**Apply on explicit request only. When the user asks to update their local copy / apply the changes, run `update.py`
yourself — you know the command, don't bounce it back. But only when asked: never apply unprompted after an edit, and
never run `install.py` yourself — that one stays the user's call.** `update.py` is manifest-driven: it does
`git pull --ff-only` on `~/.preemdeck`, then re-installs every harness recorded in
`~/.preemdeck/.install-manifest.json`.

Canonical flow — run on request (step 2 is yours now; `install.py` never is):

```bash
git -C <dev-repo> add -A && git commit -m "…" && git push   # 1. dev repo: commit + push
python3 ~/.preemdeck/update.py                              # 2. deployed source: pull --ff-only + re-install
```

Then restart the host CLI — plugins load at startup. To reverse an install,
`python3 ~/.preemdeck/uninstall.py [harness]` restores the `.bak` backups, unregisters the plugins, and drops the
harness from the manifest (`--dry-run` to preview, `--purge` to print the manual `rm -rf ~/.preemdeck`).

## Agents

See [`llm-docs/INDEX.md`](llm-docs/INDEX.md) for the full working references (Claude↔Codex↔Gemini, coding standards,
contribution guide, how-to-create agents/hooks/skills).
