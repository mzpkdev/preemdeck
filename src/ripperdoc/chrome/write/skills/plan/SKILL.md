---
description: |
  Produce a clear, right-sized implementation plan before writing code. Reach for it when the user wants the
  work scoped and sequenced first: "plan this out", "make an implementation plan", "what order do we tackle
  this", "scope this", or the slash command `write:plan`. Also for migrations, refactors, and multi-file
  integrations where sequence and blast radius matter. Not for direct "add X" / "implement Y" requests,
  debugging, or a pure explanation.
argument-hint: "[spec, feature description, or requirements]"
user-invocable: true
allowed-tools: [Read, Glob, Grep, Agent, AskUserQuestion, Write, Skill, EnterPlanMode, ExitPlanMode]
---

# Overview

Turn a task into a reviewable implementation plan: research, resolve the forks, lay out concrete verifiable steps. The
user approves it before any code lands.

## Prerequisites

1. A spec or requirements to plan. If missing, ask via `AskUserQuestion` first.
2. A plan-mode host (`EnterPlanMode` / `ExitPlanMode`); holo optional, for the editable diagram surface.

## Instructions

1. **Enter plan mode.** Call `EnterPlanMode`.
2. **Research**, in order:
   - the spec: every requirement, constraint, acceptance criterion.
   - the project: CLAUDE.md, README, manifest, layout, conventions.
   - the integration code the new code will touch.
   - the quality toolchain and its exact commands (test, lint, format, types).
3. **Resolve the forks.** Adopt a default silently only when a file or pattern backs it, cite the path; send every other
   fork to the user via `AskUserQuestion` before writing.
4. **Write the plan** to that file, following the **Template** below.
5. **Present via `ExitPlanMode`.** It reads the plan file. With holo, the user edits the prose and diagram in the IDE
   and edits persist back.
6. **On accept, re-read the file.** The user's edits are the plan, not your last draft.

## Template

```mdx
# <plan title>

## Goal

<what "done" looks like, in a sentence or two>

## Approach

<the strategy and the key decisions, each with its reason>

## Steps

<ordered by dependency; each step one concrete action>

- [ ] `<C|M|D|R>` `path/to/file` — <what this step does> <the actual code; for a test, the behavioral contract to
      verify> **Verify:** `<command that runs what CI runs: tests + lint + types>`

## Risks / assumptions

- <what you resolved; what the reviewer should weigh>

:::diagram <diagram structure — class or component/architecture, via /holo:using> :::
```

## Checklist

- [ ] No placeholders or half-written steps
- [ ] Every step has exact paths, a marker, and a Verify line
- [ ] Ordered by dependency; spec fully covered, no scope creep
- [ ] Independent subsystems split into separate plans
