---
description: |
  Produce a clear, right-sized implementation plan before writing code.
  (Trigger on 'plan this out', 'make an implementation plan', 'what order do
  we tackle this', 'scope this', or `write:plan`. For migrations, refactors,
  and multi-file integrations where sequence and blast radius matter; not
  direct 'add X' / 'implement Y', debugging, or a pure explanation.)
argument-hint: "[spec, feature description, or requirements]"
user-invocable: true
allowed-tools: [Read, Glob, Grep, Agent, AskUserQuestion, Write, Edit, Bash, Skill]
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
- holo — the plan gate and editable review surface; ships with preemdeck. When its page cannot reach the reviewer
  (`verdict=none`), the ask-user tool is the fallback gate.

## Instructions

1. **Go read-only.** Self-enforced on every host — this skill never enters the harness's plan mode. You MUST NOT modify
   source, tests, or config until the reviewer approves the plan; the only file you write is the plan itself.
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
5. **Write the plan**, following the **Template** below, to `$(git rev-parse --show-toplevel)/.preemdeck/plan/<slug>.md`
   (outside a git repo: `${TMPDIR}/preemdeck/plan/<slug>.md`) — the same path on every host. Map the touched files and
   each one's single responsibility before writing steps; put structure and interfaces in the diagram, not step prose.
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

8. **Present — the holo gate.** Serve the plan as a blocking approval gate; the reviewer edits the page (prose, diagram,
   notes — every edit persists to the file) and clicks the one verdict the page offers:

   ```bash
   "$HOME/.preemdeck/preemdeck-runtime" "$HOME/.preemdeck/src/ripperdoc/chrome/holo/apps/planner/serve.ts" \
     <plan.md> --wait --kill-on-disconnect
   ```

   In a JetBrains terminal (`in-idea.ts -q` exits 0): add
   `--css "$HOME/.preemdeck/src/ripperdoc/dock/idea/toolbox/plan-preview.css"` and open the printed url in the IDE via
   `open-url.ts` (see /idea:using). Anywhere else: add `--open`. Run the command at the host's maximum tool timeout; on
   a timeout, re-run it — a verdict clicked while nothing listened is delivered instantly from the `<plan>.verdict`
   sidecar. The command's LAST stdout line is the verdict.

   **One port per plan, one tab per plan.** Pick a port on the first round (read the actually-bound port off the `ready`
   banner — Vite bumps when taken) and pass the SAME `--port` on every re-serve of this plan. Open the url
   (`open-url.ts` / `--open`) on the FIRST round only: after a rework verdict the dead page keeps polling that port and
   reloads itself the moment the re-serve binds, so the reviewer stays in the same tab. If the banner ever shows a
   different port than requested (stolen between rounds), re-open the url once. Pass `--revision <round>` on every serve
   (1 on the first) — rounds past the first badge the reloaded page as updated.

9. **Act on the verdict:**
   - `verdict=approve` — you MUST re-read the plan file before implementing; the reviewer's edits are the plan, not your
     last draft.
   - `verdict=reject` — re-read the plan and address EVERY `:llm-note`: make the change it asks, then remove the
     directive keeping the wrapped text. Re-serve (step 8). A plan re-served with notes still in it is a plan you
     haven't finished reading.
   - `verdict=none` (the tab closed without a click) — ask for the decision via the host's ask-user tool.

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

<OPTIONAL: one :::mermaid block (carrier syntax via /holo:using) for a sequence or state diagram ONLY — the two kinds
:::diagram cannot draw; structure and dataflow stay in the editable diagram above>

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
- [ ] Structure lives in the diagram, not duplicated in step prose; :::mermaid only for sequence/state
- [ ] Critic dispatched where the host supports subagents; blocking findings fixed, one round only

## Handoff

On approve, the plan is the contract: execute it step by step, or hand it to the implementer. On reject, the notes drive
the rework loop (instruction 9). If the user wanted only the plan, stop here.
