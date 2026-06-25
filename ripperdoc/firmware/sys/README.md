# sys

System-level firmware plugin. **Scaffold only** — the manifests are wired into all three hosts and registered in both
`firmware` marketplace files, but no behavior ships yet. Add a hook, command, or skill, then document it here.

---

## What ships

| File                         | Role            |
| ---------------------------- | --------------- |
| `.claude-plugin/plugin.json` | Claude manifest |
| `.codex-plugin/plugin.json`  | Codex manifest  |
| `gemini-extension.json`      | Gemini manifest |
| `README.md`                  | This file       |

---

## Next

Pick a shape and wire it in:

- **Hook** — add a `hooks` block to each manifest (`UserPromptSubmit` on Claude/Codex, `BeforeAgent` on Gemini) pointing
  at `$HOME/.preemdeck/scripts/preemdeck-bun "${CLAUDE_PLUGIN_ROOT}/scripts/<name>.ts"` (use `${extensionPath}` on
  Gemini). Drop the script under `scripts/` with a colocated `<name>.test.ts`.
- **Command** — add `commands/<name>.toml` (Gemini) and/or a backing `skills/<name>/SKILL.md`.
- **Skill** — add `skills/<name>/SKILL.md` for a model- or user-invocable capability.
