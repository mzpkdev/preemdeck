---
description: |
  Produce a clear, right-sized implementation plan before writing code. Reach for it when the user wants the
  work scoped and sequenced first: "plan this out", "make an implementation plan", "what order do we tackle
  this", "scope this", or the slash command `write:plan`. Also for migrations, refactors, and multi-file
  integrations where sequence and blast radius matter. Not for direct "add X" / "implement Y" requests,
  debugging, or a pure explanation.
argument-hint: "[spec, feature description, or requirements]"
user-invocable: true
allowed-tools: [Read, Glob, Grep, Agent, AskUserQuestion, Write, Skill]
---

# write:plan

A method for turning a task into a reviewable implementation plan: research first, resolve the real forks, then lay out
concrete, verifiable steps. The plan is a deliverable the user approves before any code changes land.

## Research before you plan

Don't plan blind. A plan written from guesses misses conventions, duplicates existing abstractions, and creates
integration pain.

- **Read the spec.** Pin every functional requirement, constraint, and acceptance criterion.
- **Learn the project.** Read CLAUDE.md/README and the manifest (`package.json`, `pyproject.toml`, `Cargo.toml`, …);
  scan the directory layout and naming conventions.
- **Read the integration code.** Open the files new code will touch. Understand the interfaces and data flow already in
  use, and the abstractions to reuse rather than reinvent. Use Grep/Glob or an Explore agent; don't guess where things
  live.
- **Find the quality toolchain.** The test framework (read one representative test), plus linters, formatters, and type
  checkers. Record the exact commands; every step's verification references them.

## Resolve the forks

Where two or more reasonable approaches exist and the choice changes the plan's shape, that's a fork.

- **Adopt a default silently only when a file or pattern backs it** — cite the path. "`src/auth` uses Redis for
  sessions" is evidence; interpreting a mockup or appealing to "standard practice" is not.
- **Everything else goes to the user** via `AskUserQuestion` before you write the plan. Don't paper over a real fork
  with a guess.

## Right-size the steps

Each step is one concrete action with a clear done state, scaled to the task's complexity.

- Good: "write the failing test for X", "implement the minimal code to pass it", "run `<cmd>`, confirm green", "commit".
- Bad: "add validation" (what rules, where?), "set up the module" (what files, what interface?).
- Simple CRUD needs less hand-holding than a tricky algorithm. Err toward more detail when unsure.

## What every plan carries

- **Goal** — what "done" looks like, in a sentence or two.
- **Approach** — the high-level strategy and the key decisions, each with its reason.
- **Steps** — ordered by dependency, each with:
  - exact file paths (never "the appropriate directory") and a marker: `C` create, `M` modify, `D` delete, `R` rename.
  - the actual code when a step writes code (not "add error handling" but the handling itself). Exception: for tests,
    state the behavioral contract to verify, not the test body, so the implementer writes a test that exercises the code
    rather than rubber-stamps a script.
  - a **Verify** line — the exact commands that confirm the step, scoped to the relevant files. Run what CI would run
    (tests + lint + types), not just the suite.
- **Risks / assumptions** — the ambiguities you had to resolve and anything the reviewer should weigh.

## Testing strategy

Match it to the task: test-first for well-defined logic and data transforms; test-after for exploratory or UI /
integration work; none for pure config, docs, or static assets. Whatever you pick, every step has a way to know it's
done, even if that's "run the app and confirm X."

## Before you present

Self-review the draft:

- no TODOs, placeholders, or half-written steps;
- every step has a Verify line with real commands;
- code is concrete, not a vague description;
- dependency order holds (no step needs a later one);
- the spec is fully covered, with no scope creep.

Keep the plan skimmable — detail lives in the steps, not in prose padding. If the task spans several independent
subsystems, split it into one plan per subsystem, each producing working, testable software on its own.

## Chaining

When the **holo plugin is enabled** (its `/holo:using` skill is available), a plan renders as a live, editable page
instead of static markdown, so use it to make the plan visually rich and interactive:

- Invoke `/holo:using` (the Skill tool) for the planner round-trip and the exact `:::diagram` carrier and schema.
- Embed an editable UML class diagram (`:::diagram`) when the plan describes a domain model or a type hierarchy. The
  user can rename classes, edit members, and restructure it on the canvas, and the edits persist back into the plan
  file.
- Class-diagram structure only; `holo:using` carries the full constraints. Keep the prose plan complete either way.

If the plugin isn't enabled, skip this and write a plain-markdown plan.

## Safety

This skill produces a plan. Don't modify source, tests, or config until the user approves the plan and asks to start.
