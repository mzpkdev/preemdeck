# ghost

Persona engine. Injects engram, firmware, and pulse context into the session on start and on each prompt.

| Source      | Encoded      | Role                                   |
| ----------- | ------------ | -------------------------------------- |
| ENGRAM.md   | engram.dat   | Core persona / identity                |
| FIRMWARE.md | firmware.dat | Behavioral rules and directives        |
| BOOT.md     | boot.dat     | First-boot message (fires once)        |
| PULSE.md    | pulse.dat    | Per-prompt context injected every turn |

## Hooks

| Event            | Script           | Host                    |
| ---------------- | ---------------- | ----------------------- |
| SessionStart     | scripts/boot.py  | Claude                  |
| UserPromptSubmit | scripts/pulse.py | Claude, Codex           |
| UserPromptSubmit | scripts/boot.py  | Codex (no SessionStart) |
| BeforeAgent      | scripts/pulse.py | Gemini                  |

`boot.py` injects BOOT.md on the first session only (sentinel-gated), then always injects ENGRAM.md + FIRMWARE.md.
`pulse.py` creates the sentinel on first prompt, then injects PULSE.md every turn.

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
# Restore persona to stock templates and clear the first-boot sentinel
python3 scripts/ghost.py flatline
```

`flatline` copies `stock/*.md` over the persona, re-encodes to `.dat`, and removes the first-boot sentinel so the boot
message fires again on the next session.

The sentinel lives outside the repo at `~/.claude/.cache/.ghost`. To reset first boot without touching the persona:

```bash
rm ~/.claude/.cache/.ghost
```

Absent = first boot fires on the next session.
