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

## Memory

Ghost accumulates persona facts about the user across sessions in a local SQLite database.

| Layer      | What                             | When                                      |
| ---------- | -------------------------------- | ----------------------------------------- |
| Short-term | 10 most recent (+ pinned) traces | Injected every `SessionStart`             |
| Long-term  | Full archive, FTS5-searchable    | Recalled on demand via `ghost-echo` skill |

**Cortex location:** `~/.claude/.cache/.ghost_cortex.db`

`engrave.py` runs after each turn (`Stop` hook, async) and calls Claude Haiku to extract persona facts from the
transcript. Facts are stored as individual rows in the `traces` table.

The `ghost-echo` skill is auto-invoked by the model when the user references shared history or asks about past
interactions. It queries the FTS5 index and returns matching traces.

### Commands

```bash
# Wipe memory only
python3 scripts/ghost.py wipe_memory

# Full reset (persona + memory + sentinel)
python3 scripts/ghost.py flatline
```

### Requirements

`engrave.py` requires `ANTHROPIC_API_KEY` to be set. Without it, the hook exits silently and no traces are written. The
`anthropic` Python package must be importable from the system `python3`.

## Resetting first boot

```bash
rm ~/.claude/.cache/.ghost
```

The sentinel lives outside the repo. Absent = first boot fires on the next session.
