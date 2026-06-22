# directive

A persisted **directive toggle** — independent behavioral slots, each holding the active directive for that slot,
applied per prompt. Each mode is a **skill folder** that doubles as its own setter:

```
skills/swarm/
  SKILL.md       # invoke /swarm → runs set_mode.py strategy swarm (persists)
  directive.md   # the prose the hook injects
  agents/openai.yaml
```

- **Invoke a mode (set it)** — `/swarm`, `/ask`, `/auto` each run `set_mode.py <slot> <value>`, writing that mode into
  `preemdeck.json`. (On Gemini, the equivalent `commands/<mode>.toml` does the same.)
- **Hook (apply it)** — every prompt, `inject_mode.py` reads the `directive` object from the root `preemdeck.json` and
  injects each active slot's `directive.md` body, concatenated in slot order. Wired on all three hosts
  (`UserPromptSubmit` on Claude/Codex, `BeforeAgent` on Gemini).

Two slots ship, on independent axes:

| slot         | axis                   | values (empty = neutral)                      |
| ------------ | ---------------------- | --------------------------------------------- |
| `strategy`   | how the work gets done | `swarm` — empty leaves it hands-on            |
| `discretion` | who makes the call     | `ask` / `auto` — empty asks only when blocked |

```json
{
  "directive": {
    "strategy": "",
    "discretion": ""
  }
}
```

An empty value is **neutral** — that slot injects nothing. Both empty (the shipped default) means the hook is inert
until you set a mode. The slots compose: `strategy=swarm` + `discretion=auto` = fan out fixers and drive to done without
checking in.

The mode skills are **user-invocable and never model-invoked** (`disable-model-invocation`, mirrored on Codex via
`agents/openai.yaml`) — a mode is set by you, never auto-selected. `set_mode.py` is the only writer of `preemdeck.json`.

Lookups are pure `pathlib` (OS-agnostic): `preemdeck.json` is found by walking up from the hook to the clone root
(`~/.claude`, `~/.codex`, `~/.gemini`); `skills/<value>/directive.md` is resolved inside the plugin. An unset slot, an
empty value, or a value with no matching `directive.md` is a silent no-op.

______________________________________________________________________

## What ships

| File                         | Role                                                            |
| ---------------------------- | --------------------------------------------------------------- |
| `scripts/inject_mode.py`     | Hook — injects each active slot's `skills/<value>/directive.md` |
| `scripts/set_mode.py`        | Writer — validates `<slot>`/`<value>`, sets `directive[<slot>]` |
| `skills/<mode>/SKILL.md`     | Setter — invoking it runs `set_mode.py` for that mode           |
| `skills/<mode>/directive.md` | The prose the hook injects for that mode                        |
| `commands/<mode>.toml`       | Gemini setter command per mode                                  |
| `.claude-plugin/plugin.json` | Claude manifest + `UserPromptSubmit` hook                       |
| `.codex-plugin/plugin.json`  | Codex manifest + `UserPromptSubmit` hook                        |
| `gemini-extension.json`      | Gemini manifest + `BeforeAgent` hook                            |

Modes shipped: `swarm` (strategy), `ask` / `auto` (discretion).

______________________________________________________________________

## Notes

- **Values validate against the mode skills** (folders with a `directive.md`). Cross-slot looseness remains —
  `/directive`-style `set_mode.py strategy ask` is still accepted, since validation isn't slot-scoped. (The skills
  themselves are slot-correct: `/swarm` only ever writes `strategy`.)
- `preemdeck.json` is committed at the repo root, so `update.py`'s `git reset --hard` reverts runtime edits to it. A
  user-set directive will need an untracked state path.
