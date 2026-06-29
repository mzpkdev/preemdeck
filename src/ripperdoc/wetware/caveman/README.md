# caveman

Per-prompt hook that injects `CAVEMAN.md` as `additionalContext` on **every** user prompt — burns in an ultra-compressed
"talk like smart caveman" output mode that cuts ~75% of output tokens while keeping full technical accuracy. Wired to
`UserPromptSubmit` on Claude/Codex and `BeforeAgent` on Gemini — one envelope shape works on all three.

Ported from [caveman](https://github.com/JuliusBrussee/caveman) (Julius Brussee). This is the **core mode only**,
always-on at `full` intensity — the upstream `/caveman` level switch, `caveman-compress` (Python), `caveman-stats`, and
the cavecrew subagents are not ported.

---

## What ships

| File                         | Role                                                                        |
| ---------------------------- | --------------------------------------------------------------------------- |
| `CAVEMAN.md`                 | The injected ruleset — compression rules, intensity reference, escape hatch |
| `scripts/inject-hook.ts`     | Injection hook — reads `CAVEMAN.md` and emits the cross-host envelope       |
| `.claude-plugin/plugin.json` | Claude manifest + inline `hooks` block (`UserPromptSubmit`, `--every 1`)    |
| `.codex-plugin/plugin.json`  | Codex manifest + inline `hooks` block (`UserPromptSubmit`, `--every 1`)     |
| `gemini-extension.json`      | Gemini manifest + inline `hooks` block (`BeforeAgent`, `--every 1`)         |

`--every 1` = inject on every prompt (always active). Bump it to throttle the burn-in to every Nth prompt.

---

## Conflicts with imprint

Both `caveman` and `imprint` are always-on voice injectors — running both feeds the model two competing output styles.
`imprint` ships disabled (`DISABLED_PLUGINS` in `install.ts`); caveman is the active voice layer. Enabling both is not
advised.

---

## Codex needs an extra opt-in

Codex plugin hooks are off by default. Without the flag, the hook installs but never fires — no error, no warning, no
injection.

```toml
# ~/.codex/config.toml
[features]
plugin_hooks = true
```

After install, run `/hooks` inside Codex to review and trust the caveman hook. This is a **separate** gate from the
project-trust mechanism.

---

## Customize

Edit `CAVEMAN.md` to tune the ruleset or pin a different intensity. If it is missing or empty, the hook exits 0 silently
— no surfaced error.
