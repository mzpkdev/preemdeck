# mode-example

Scaffold for a persisted **mode toggle**. Two halves:

- **Mode-routing hook** — on every prompt, reads the active mode from the root `preemdeck.json` and injects that mode's
  `modes/<mode>.md` as context. Wired on all three hosts (`UserPromptSubmit` on Claude/Codex, `BeforeAgent` on Gemini).
- **`/mode <mode>` skill** — will flip the mode in `preemdeck.json`. Currently a no-op stub.

The active mode is the `mode-example` field of `preemdeck.json` (repo root, e.g. `{ "mode-example": "mode-a" }`). Three
example modes ship: `mode-a`, `mode-b`, `mode-c`.

Two lookups, both pure `pathlib` (OS-agnostic):

- `preemdeck.json` — found by walking up from the hook's own location until it hits the file. Resolves in-repo and once
  installed, since every host nests the plugin copy under its clone root (`~/.claude`, `~/.codex`, `~/.gemini`) where
  `preemdeck.json` lives.
- `modes/<mode>.md` — shipped inside the plugin, resolved relative to the hook.

An unset field, unknown mode, or missing/empty md is a silent no-op.

______________________________________________________________________

## What ships

| File                         | Role                                                |
| ---------------------------- | --------------------------------------------------- |
| `scripts/inject_mode.py`     | Hook — reads active mode, injects `modes/<mode>.md` |
| `modes/mode-{a,b,c}.md`      | Three example mode prompts                          |
| `skills/mode/SKILL.md`       | `/mode <mode>` command — no-op placeholder for now  |
| `.claude-plugin/plugin.json` | Claude manifest + `UserPromptSubmit` hook           |
| `.codex-plugin/plugin.json`  | Codex manifest + `UserPromptSubmit` hook            |
| `gemini-extension.json`      | Gemini manifest + `BeforeAgent` hook                |

______________________________________________________________________

## Note

`preemdeck.json` is committed at the repo root, so `update.py`'s `git reset --hard` reverts runtime edits to it. Fine
while it's a static example; the writable toggle will need an untracked state path.
