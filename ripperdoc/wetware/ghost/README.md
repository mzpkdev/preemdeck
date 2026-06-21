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
| SessionStart     | scripts/boot.py  | Claude                  |
| UserPromptSubmit | scripts/pulse.py | Claude, Codex           |
| UserPromptSubmit | scripts/boot.py  | Codex (no SessionStart) |
| BeforeAgent      | scripts/pulse.py | Gemini                  |

`boot.py` injects ENGRAM.md + FIRMWARE.md on session start. `pulse.py` injects PULSE.md every turn.

## Editing

```bash
# Decode .dat files back to editable .md
python3 scripts/ghost.py decode

# Edit the .md files, then re-encode
python3 scripts/ghost.py encode
```

`decode` keeps the `.dat` files in place so hooks continue to work during editing. `encode` writes `.dat` files and
removes the `.md` files.

## Resetting

```bash
# Restore persona to stock templates
python3 scripts/ghost.py flatline
```

`flatline` copies `stock/*.md` over the persona and re-encodes to `.dat`.
