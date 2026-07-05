---
description: |
  Produce a clear, right-sized implementation plan before writing code.
  (Trigger on 'plan this out', 'make an implementation plan', 'what order do
  we tackle this', 'scope this', or `write:plan`. For migrations, refactors,
  and multi-file integrations where sequence and blast radius matter; not
  direct 'add X' / 'implement Y', debugging, or a pure explanation.)
argument-hint: "[spec, feature description, or requirements]"
user-invocable: true
allowed-tools: [Read, Glob, Grep, Agent, AskUserQuestion, Write, Skill, EnterPlanMode, ExitPlanMode]
---

# Plan

## Overview

Turn a task into a reviewable implementation plan: research, resolve the forks, lay out concrete verifiable steps. The
user approves it before any code lands. Write each step for an implementer with zero repo context — exact paths,
complete code, exact commands — structure lives in the diagram, code in the steps, and prose stays lean.

## Announcement

"Scoping this into a reviewable plan before any code lands."

## Prerequisites

- A spec or requirements to plan — REQUIRED. A bare idea is not one: you MUST build the requirements first via the
  host's ask-user tool (`AskUserQuestion` on Claude, `ask_user_question` on Codex, `ask_user` on Gemini) — one question
  per message, concrete options preferred — until purpose, constraints, and success criteria are pinned.
- holo — OPTIONAL; adds the editable diagram surface.

## Instructions

1. **Go read-only.** Enter plan mode where the host has a tool for it (`EnterPlanMode` on Claude, `enter_plan_mode` on
   Gemini); Codex has no entry tool, so proceed and self-enforce. Either way you MUST NOT modify source, tests, or
   config until the user approves the plan.
2. **Triage scope.** If the request spans independent subsystems, you MUST split it — one plan per subsystem, this pass
   plans the first. Decide this now, not after the steps are written.
3. **Research**, in order:
   - the spec: every requirement, constraint, acceptance criterion.
   - the project: the context file (CLAUDE.md / AGENTS.md / GEMINI.md), README, manifest, layout, conventions.
   - the integration code the new code will touch.
   - the quality toolchain and its exact commands (test, lint, format, types).
4. **Resolve the forks.** You MAY adopt a default silently only when a file or pattern backs it — cite the path. Every
   other fork MUST go to the user via the host's ask-user tool before you write — 2-3 concrete options with trade-offs,
   your recommendation first. Cut anything the goal does not need (YAGNI).
5. **Write the plan**, following the **Template** below, to the host's plan file. Map the touched files and each one's
   single responsibility before writing steps; put structure and interfaces in the diagram, not step prose.
   - Claude: the file `EnterPlanMode` named.
   - Gemini: a file in the plans directory (`${GEMINI_PLANS_DIR}`).
   - Codex: `$(git rev-parse --show-toplevel)/.preemdeck/plan/<slug>.md`; outside a git repo,
     `${TMPDIR}/preemdeck/plan/<slug>.md`.
6. **Self-review, fix inline** — one pass, no re-review loop:
   - coverage: every spec requirement points at a step; uncovered gets a step, extra gets cut.
   - placeholders: scan for the **Avoid** patterns below.
   - drift: names and signatures identical across steps and diagram.
7. **Critic review** — fresh eyes before the user's. Dispatch the `critic` worker via the host's subagent tool; on a
   host without subagent dispatch, skip — self-review already ran. The critic gets the plan file and the spec (the file,
   or the requirements verbatim when there is none), NEVER the conversation; it MAY read repo files to judge
   feasibility. Fix blocking findings inline; recommendations are advisory. One round — you MUST NOT re-dispatch after
   fixes. Dispatch prompt:

   ```text
   Review the implementation plan at <plan file> against this spec: <spec file, or requirements verbatim>.
   Judge one question: would an implementer with zero repo context, following this plan alone, build the
   right thing without getting stuck? Check for: spec requirements no step covers; contradictory or vague
   steps; placeholder content; names or signatures that drift between steps; Verify commands that don't
   prove their step. Flag only what would block or mislead the implementer — wording and style are not
   findings. Approve unless something serious is wrong. Return: Status (Approved | Issues Found); Issues
   as [step — problem — why it blocks]; Recommendations (advisory, non-blocking).
   ```

8. **Present.** On Claude / Gemini call the plan-mode exit tool — it reads the plan file; with holo, the user edits the
   prose and diagram in the IDE and edits persist back. On Codex, show the plan in chat and ask for approval via the
   ask-user tool.
9. **On accept, you MUST re-read the plan file** before implementing — the user's edits are the plan, not your last
   draft.

## Template

````mdx
# <plan title>

## Goal

<what "done" looks like, in a sentence or two>

## Constraints

<project-wide rules copied verbatim from the spec — version floors, naming, platform limits — one line each; every step
inherits them. Omit the section when the spec sets none.>

## Approach

<the strategy and the key decisions, each with its reason — name the rejected alternative when the call was close>

:::diagram <the structural story — components/classes, new and changed interfaces, flow — via /holo:using; steps
reference these nodes by name instead of re-describing them> :::

## Steps

<tasks ordered by dependency; a task is the smallest unit worth a reviewer's gate — split only where a reviewer could
reject one task while approving its neighbor; each step one concrete action, executable without reading other tasks>

### <N>. <task name>

- [ ] `<C|M|D|R>` `path/to/file` — <what this step does>

  ```<lang>
  <the complete code this step lands — for a test, the actual test; a signature alone is a placeholder>
  ```

  **Verify:** `<the CI command: tests+lint+types>` → <expected result; for a test-first step, the expected failure>

## Risks / assumptions

- <what you resolved; what the reviewer should weigh>

## Done when

- `<the full CI command>` → all PASS
- <the observable behavior that proves the goal, and how to observe it>
````

## Examples

**Prefer** — one task, one concrete step, the complete code, a check with its expected result:

````md
### 1. Token refresh

- [ ] `M` `src/auth/token.ts` — refresh at 80% of TTL

  ```ts
  export function refreshAt(expiresAt: number): number {
    return now() + Math.max(0, expiresAt - now()) * 0.8;
  }
  ```

  **Verify:** `bun test src/auth` → PASS, new case "refreshes at 80%"
````

**Avoid:**

- `- [ ] Improve the auth system` — vague, unbounded, no path, no marker, no Verify.
- `- [ ] M src/auth/token.ts — add error handling and edge cases` — placeholder: name each case or cut the step.
- `- [ ] M src/auth/token.ts — add refreshAt(expiresAt: number): number` with no code block — a signature is not the
  change; land the code.
- `- [ ] M src/auth/session.ts — same as task 1 for sessions` — tasks are read alone: repeat the exact content.

## Checklist

Before ending the turn, confirm:

- [ ] Every spec requirement maps to a step; nothing beyond the goal (YAGNI)
- [ ] No placeholder patterns: TBD, "handle edge cases", "add validation", "same as task N", code-free signatures
- [ ] Names and signatures identical across tasks and diagram
- [ ] Every step: exact path, marker, complete code where code changes, Verify with expected result
- [ ] Ordered by dependency; independent subsystems split into separate plans
- [ ] Structure lives in the diagram, not duplicated in step prose
- [ ] Critic dispatched where the host supports subagents; blocking findings fixed, one round only

## Handoff

On accept, the plan is the contract: execute it step by step, or hand it to the implementer. On reject, fold the user's
edits and re-present. If the user wanted only the plan, stop here.
