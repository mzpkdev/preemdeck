---
description: |
  Inspect current ghost state — rapport stats (trust, attachment, instability) plus
  the N most recent memories. User-invoked via /debug, optionally /debug <N> to
  override the memory count. Read-only diagnostic; does not mutate state.
user-invocable: true
allowed-tools: [Bash]
---

# Debug

Dump current ghost state for inspection — including how the current rapport values shape LLM behavior.

## How to run

1. Parse `$ARGUMENTS` for an optional integer N. Default to `5`. Cap at `50` to prevent dumping. Reject non-integers —
   fall back to default.

2. Query rapport (singleton row):

```bash
sqlite3 -separator $'\t' ~/.claude/.cache/.ghost_cortex.db \
  "SELECT trust, attachment, instability, updated_at FROM rapport WHERE id = 1" \
  2>/dev/null
```

3. Query recent memories:

```bash
sqlite3 -separator $'\t' ~/.claude/.cache/.ghost_cortex.db \
  "SELECT memory, recorded_at, surfaced FROM memories ORDER BY recorded_at DESC LIMIT <N>" \
  2>/dev/null
```

4. Read the rapport band definitions:

```bash
cat "${CLAUDE_PLUGIN_ROOT}/RAPPORT.md"
```

This file is the source of truth for how each stat affects responses. Three markdown tables, one per stat (trust,
attachment, instability). Each row has a `Range` column like `-20..+20` and a short behavior description. **Do not cache
or hardcode the bands — re-read this file each invocation so it stays in sync with user edits.**

If the DB does not exist, say so on a single line — do not create it.

## How to map values to bands

For each stat (trust, attachment, instability):

1. Find the table for that stat in RAPPORT.md.
2. Locate the row whose `Range` contains the current integer value. Ranges are inclusive on the low end; pick the band
   that contains the value (e.g. `0` → `-20..+20` for trust).
3. Extract a **one-phrase** band label from that row's behavior column — the essential register, not the full sentence.
   Examples: `baseline — opinionated, blunt, engaged`, `rare bleed-through`, `stable engram`.

## What to return

Plain text, aligned, terse. No borders, no decoration. Format:

```
rapport
  trust        <n>   <band phrase>
  attachment   <n>   <band phrase>
  instability  <n>   <band phrase>
  updated      <timestamp>

interpretation
  <1-2 sentence synthesis of how the three compose — what register, disclosure, and stability to expect from responses right now>

memories (<count>)
  [<recorded_at>] surfaced=<n>  <memory>
  ...
```

If rapport row is missing: `rapport  (none)` and omit the `interpretation` block. If no memories: `memories  (none)`.

The `interpretation` paragraph should describe **behavior** ("expect baseline register, rare persona bleed-through,
stable engram"), not meaning ("the user trusts you a lot"). Keep it to 1-2 sentences.

## Critical

This is a diagnostic dump. No narration, no preamble, no commentary beyond the `interpretation` block. The
interpretation describes the behavioral consequence of the current state — it does not editorialize about the user or
the relationship. Print the state and stop.
