# imprint

Per-prompt hook that injects `IMPRINT.md` as `additionalContext` on every user prompt, with host-specific tooling info
substituted into a `{{host_tools}}` placeholder. Wired to `UserPromptSubmit` on Claude/Codex and `BeforeAgent` on Gemini
— one envelope shape works on all three.

______________________________________________________________________

## What ships

| File                                  | Role                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| `IMPRINT.md`                          | Prompt template — host-agnostic body with a `{{host_tools}}` placeholder        |
| `hosts/host_{claude,codex,gemini}.md` | Host-specific tooling guide — each manifest points its hook at one of these     |
| `scripts/inject-hook.ts`              | Injection hook — substitutes `{{host_tools}}` and emits the cross-host envelope |
| `.claude-plugin/plugin.json`          | Claude manifest + inline `hooks` block (`UserPromptSubmit`)                     |
| `.codex-plugin/plugin.json`           | Codex manifest + inline `hooks` block (`UserPromptSubmit`)                      |
| `gemini-extension.json`               | Gemini manifest + inline `hooks` block (`BeforeAgent`, sets `contextFileName`)  |

______________________________________________________________________

## Codex needs an extra opt-in

Codex plugin hooks are off by default. Without the flag, the hook installs but never fires — no error, no warning, no
injection.

```toml
# ~/.codex/config.toml
[features]
plugin_hooks = true
```

After install, run `/hooks` inside Codex to review and trust the imprint hook. This is a **separate** gate from the
project-trust mechanism — installing the plugin and trusting the project does not auto-trust the hooks inside.

______________________________________________________________________

## Customize

Edit `IMPRINT.md` for the host-agnostic body. Edit `host_<host>.md` for the tooling guide specific to each host (spawn
syntax, available tools, host quirks). The hook reads both, substitutes the host file's contents into `{{host_tools}}`,
and ships the result.

If either file is missing or empty, the hook exits 0 silently — `{{host_tools}}` substitutes to empty when the host file
is missing; the whole injection skips when the prompt template is missing. No surfaced error in either case.
