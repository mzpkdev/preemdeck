# directive

A persisted **directive toggle** — independent behavioral slots, each holding the active directive for that slot,
applied per prompt. One setter writes; each mode is a **skill folder** that echoes its own directive:

```
skills/swarm/
  SKILL.md       # invoke /swarm → prints skills/swarm/directive.md (shows, never writes)
  directive.md   # the prose the hook injects
  agents/openai.yaml
scripts/modes.json  # central value→slot manifest (swarm/team→strategy, ask/auto→discretion)
skills/default/
  SKILL.md       # invoke /directive:default <value> → runs set-mode.ts <value> (the sole writer)
  agents/openai.yaml
```

- **Set a directive** — `/directive:default <value>` (`ask`|`swarm`|`team`|`auto`) runs `set-mode.ts <value>`, the only
  thing that writes `preemdeck.json`. The value alone decides the slot: `set-mode.ts` looks it up in
  `scripts/modes.json` (the central value→slot manifest) to derive it. (On Gemini, `commands/default.toml` does the
  same.)
- **Show a directive** — `/swarm`, `/team`, `/ask`, `/auto` each run `show-mode.ts <mode>`, printing that mode's
  `directive.md` verbatim. They write nothing. (On Gemini, the equivalent `commands/<mode>.toml` does the same.)
- **Hook (apply it)** — every prompt, `inject-mode.ts` reads the `directive` object from the root `preemdeck.json` and
  injects each active slot's `directive.md` body, concatenated in slot order. Wired on all three hosts
  (`UserPromptSubmit` on Claude/Codex, `BeforeAgent` on Gemini).

Two slots ship, on independent axes:

| slot         | axis                   | values (empty = neutral)                      |
| ------------ | ---------------------- | --------------------------------------------- |
| `strategy`   | how the work gets done | `swarm` / `team` — empty leaves it hands-on   |
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
`agents/openai.yaml`) — a directive is set by you, never auto-selected. `set-mode.ts` is the only writer of
`preemdeck.json`.

Lookups are pure `pathlib` (OS-agnostic): `preemdeck.json` is found by walking up from the hook to the clone root
(`~/.claude`, `~/.codex`, `~/.gemini`); `skills/<value>/directive.md` and `scripts/modes.json` are resolved inside the
plugin. Value-validity stays folder-based — a mode is a folder with `directive.md`; `modes.json` only supplies the slot.
An unset slot, an empty value, or a value with no matching `directive.md` is a silent no-op.

---

## What ships

| File                         | Role                                                             |
| ---------------------------- | ---------------------------------------------------------------- |
| `scripts/inject-mode.ts`     | Hook — injects each active slot's `skills/<value>/directive.md`  |
| `scripts/set-mode.ts`        | Writer — validates `<value>`, derives its slot, sets `directive` |
| `scripts/show-mode.ts`       | Reader — prints `skills/<value>/directive.md` verbatim           |
| `scripts/modes.json`         | Central value→slot manifest (`set-mode.ts` reads it)             |
| `skills/default/SKILL.md`    | Setter — `/directive:default <value>` runs `set-mode.ts`         |
| `skills/<mode>/SKILL.md`     | Echo — invoking it runs `show-mode.ts` for that mode             |
| `skills/<mode>/directive.md` | The prose the hook injects for that mode                         |
| `commands/default.toml`      | Gemini setter command                                            |
| `commands/<mode>.toml`       | Gemini echo command per mode                                     |
| `.claude-plugin/plugin.json` | Claude manifest + `UserPromptSubmit` hook                        |
| `.codex-plugin/plugin.json`  | Codex manifest + `UserPromptSubmit` hook                         |
| `gemini-extension.json`      | Gemini manifest + `BeforeAgent` hook                             |

Modes shipped: `swarm` / `team` (strategy), `ask` / `auto` (discretion).

---

## Notes

- **Value determines slot.** `set-mode.ts <value>` derives the slot from `scripts/modes.json`, so a mode can only ever
  write its own slot — there's no slot argument to get wrong. `skills/default/` ships no `directive.md`, so it is not
  itself a settable mode (and the echo skills never write).
- `preemdeck.json` is gitignored user-local state, written by `install.ts` from its built-in defaults on first install
  (seed-if-absent). Because git never tracks it, `boot.sh`'s `reset --hard` leaves it alone — so `set-mode.ts`'s runtime
  edits persist across re-installs.
