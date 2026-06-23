# ghost

Persona engine. Injects engram, firmware, and pulse context into the session on start and on each prompt.

| Source      | Encoded      | Role                                   |
| ----------- | ------------ | -------------------------------------- |
| ENGRAM.md   | engram.dat   | Core persona / identity                |
| FIRMWARE.md | firmware.dat | Behavioral rules and directives        |
| PULSE.md    | pulse.dat    | Per-prompt context injected every turn |

## Hooks

| Event            | Script           | Host                    |
| ---------------- | ---------------- | ----------------------- |
| SessionStart     | scripts/boot.ts  | Claude                  |
| UserPromptSubmit | scripts/pulse.ts | Claude, Codex           |
| UserPromptSubmit | scripts/boot.ts  | Codex (no SessionStart) |
| BeforeAgent      | scripts/pulse.ts | Gemini                  |

`boot.ts` injects ENGRAM.md + FIRMWARE.md on session start. `pulse.ts` injects PULSE.md every turn.

## Editing

```bash
# Decode .dat files back to editable .md
"$HOME/.preemdeck/scripts/preemdeck-bun" "${CLAUDE_PLUGIN_ROOT}/scripts/ghost.ts" decode

# Edit the .md files, then re-encode
"$HOME/.preemdeck/scripts/preemdeck-bun" "${CLAUDE_PLUGIN_ROOT}/scripts/ghost.ts" encode
```

`decode` keeps the `.dat` files in place so hooks continue to work during editing. `encode` writes `.dat` files and
removes the `.md` files.

## Resetting

```bash
# Restore persona to stock templates
"$HOME/.preemdeck/scripts/preemdeck-bun" "${CLAUDE_PLUGIN_ROOT}/scripts/ghost.ts" flatline
```

`flatline` copies `stock/*.md` over the persona and re-encodes to `.dat`.
