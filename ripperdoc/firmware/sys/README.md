# sys

System-level firmware plugin. Ships **`/sys:update`** — a user-only command that self-updates preemdeck: it pulls
`~/.preemdeck` to your channel and re-installs every recorded harness by shelling out to the repo-root `update.ts`.
Never model-invoked on any host.

---

## What ships

| File                               | Role                                                      |
| ---------------------------------- | --------------------------------------------------------- |
| `skills/update/SKILL.md`           | `/sys:update` on Claude + Codex (user-invocable, no auto) |
| `skills/update/agents/openai.yaml` | Codex's `disable-model-invocation` equivalent             |
| `commands/update.toml`             | `/sys:update` on Gemini (TOML command surface)            |
| `.claude-plugin/plugin.json`       | Claude manifest                                           |
| `.codex-plugin/plugin.json`        | Codex manifest                                            |
| `gemini-extension.json`            | Gemini manifest                                           |
| `README.md`                        | This file                                                 |

---

## How it works

`/sys:update` runs `"$HOME/.preemdeck/scripts/preemdeck-bun" "$HOME/.preemdeck/update.ts"` and relays the output. The
command is deliberately deterministic — a fixed invocation, model-invocation disabled, body scoped to "run this, relay
verbatim." `update.ts` (repo root) does the real work: sync to channel + re-install every recorded harness.

Because the path is the absolute install root — not `${CLAUDE_PLUGIN_ROOT}` / `${extensionPath}` — the invocation is
byte-identical on all three hosts. Plugins load at startup, so an update lands on the next host-CLI restart.

### Why two surfaces

`user-invocable` and `disable-model-invocation` are Claude-only frontmatter (Codex mirrors the latter via
`agents/openai.yaml`). Gemini honors neither, and there a skill is model-invocable only — so the user-typed, never-auto
command surface on Gemini is `commands/*.toml`, not a skill.
