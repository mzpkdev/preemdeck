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

Turn a task into a reviewable implementation plan: research, resolve the forks, lay out phases a human can read and an
implementer can execute. The plan leads with outcomes — a verb-first title, the approach and its key decisions, the
phases each named by what they make true — and folds every phase's code-bearing steps (exact paths, complete code, exact
commands) inside a `:::details` block. Structure lives in the diagram, the detail in the fold, the surface stays
readable top to bottom. The user approves it before any code lands.

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
   plans the first. Decide this now, not after the phases are written.
3. **Research**, in order:
   - the spec: every requirement, constraint, acceptance criterion.
   - the project: the context file (CLAUDE.md / AGENTS.md / GEMINI.md), README, manifest, layout, conventions.
   - the integration code the new code will touch.
   - the quality toolchain and its exact commands (test, lint, format, types).
4. **Resolve the forks.** You MAY adopt a default silently only when a file or pattern backs it — cite the path. Every
   other fork MUST go to the user via the host's ask-user tool BEFORE you write — 2-3 concrete options with trade-offs,
   your recommendation first — until nothing material is unresolved. The plan you present carries no open questions; a
   fork you could not settle with the user is a fork you do not yet plan around. Cut anything the goal does not need
   (YAGNI).
5. **Write the plan**, following the **Template** below, to `$(git rev-parse --show-toplevel)/.preemdeck/plan/<slug>.md`
   (outside a git repo: `${TMPDIR}/preemdeck/plan/<slug>.md`) — the same path on every host. Map the touched files and
   each one's single responsibility before writing phases; put structure and interfaces in the diagram and the code in
   each phase's `:::details` fold, never in phase prose.
6. **Self-review, fix inline** — one pass, no re-review loop:
   - coverage: every spec requirement points at a phase; uncovered gets a phase, extra gets cut.
   - placeholders: open every fold and scan the steps for the **Avoid** patterns below.
   - drift: names and signatures identical across phases, folds, and diagram.
7. **Critic review** — fresh eyes before the user's. Dispatch the `critic` worker via the host's subagent tool; on a
   host without subagent dispatch, skip — self-review already ran. The critic gets the plan file and the spec (the file,
   or the requirements verbatim when there is none), NEVER the conversation; it MAY read repo files to judge
   feasibility. Fix blocking findings inline; recommendations are advisory. One round — you MUST NOT re-dispatch after
   fixes. Dispatch prompt:

   ```text
   Review the implementation plan at <plan file> against this spec: <spec file, or requirements verbatim>.
   Judge one question: would an implementer with zero repo context, following this plan alone (opening each
   phase's :::details fold for the steps), build the right thing without getting stuck? Check for: spec
   requirements no phase covers; a phase whose Gate does not prove it is done; contradictory or vague steps;
   placeholder content in the folds; names or signatures that drift between phases, folds, and the diagram;
   Verify commands that don't prove their step. Flag only what would block or mislead the implementer —
   wording and style are not findings. Approve unless something serious is wrong. Return: Status (Approved |
   Issues Found); Issues as [phase — problem — why it blocks]; Recommendations (advisory, non-blocking).
   ```

8. **Present — the holo gate.** Serve the plan as a blocking approval gate; the reviewer edits the page (prose, diagram,
   notes, and the folded steps — every edit persists to the file) and clicks the one verdict the page offers:

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
# PLAN: <verb-first title>

<2-3 sentences: what this builds, why now, the one thing to sanity-check.>

**Not doing:** <the scope you are deliberately leaving out, one line — omit when there is none.>

## Constraints

<project-wide rules copied verbatim from the spec — version floors, naming, platform limits — one line each; every phase
and step inherits them. Omit the section when the spec sets none.>

## Approach & Key Decisions

<the strategy and the key calls, each with its reason — name the rejected alternative when the call was close.>

:::diagram <OPTIONAL — the structural story via /holo:using: components/classes, new and changed interfaces, flow;
phases reference these nodes by name. Include only when the shape carries more than the prose does.> :::

<OPTIONAL: one :::mermaid block (carrier syntax via /holo:using) for a sequence or state diagram ONLY — the two kinds
:::diagram cannot draw.>

## Phases

<phases ordered by dependency; each the smallest unit worth a reviewer's gate — split only where a reviewer could reject
one phase while approving its neighbour. Name each by its outcome, not its activity.>

### Phase <N> — <outcome>

<1-3 sentences: the approach for this phase.>

**Gate:** <the observable fact that proves this phase is done>

:::details{summary="Implementation · <n> files"}

- [ ] `<C|M|D|R>` `path/to/file` — <what this step does>

  ```<lang>
  <the complete code this step lands — for a test, the actual test; a signature alone is a placeholder>
  ```

  **Verify:** `<the CI command: tests+lint+types>` → <expected result; for a test-first step, the expected failure>

:::

## Success Criteria

- `<the full CI command>` → all PASS
- <the observable behavior that proves the goal, and how to observe it>
````

## Examples

**Prefer** — a phase named by its outcome, a Gate that proves it, and inside the fold one concrete step with the
complete code and a check with its expected result:

````md
### Phase 1 — tokens refresh before they expire

The client swaps its token at 80% of TTL on a timer, so no request ever rides an expired token.

**Gate:** a session held open past the token's TTL keeps working with no re-login.

:::details{summary="Implementation · 1 file"}

- [ ] `M` `src/auth/token.ts` — refresh at 80% of TTL

  ```ts
  export function refreshAt(expiresAt: number): number {
    return now() + Math.max(0, expiresAt - now()) * 0.8;
  }
  ```

  **Verify:** `bun test src/auth` → PASS, new case "refreshes at 80%"

:::
````

**Avoid:**

- `### Phase 1 — auth work` — named by activity, not outcome; name what becomes true, not what you do.
- `- [ ] Improve the auth system` — vague, unbounded, no path, no marker, no Verify.
- `- [ ] M src/auth/token.ts — add error handling and edge cases` — placeholder: name each case or cut the step.
- `- [ ] M src/auth/token.ts — add refreshAt(expiresAt: number): number` with no code block — a signature is not the
  change; land the code.
- `- [ ] M src/auth/session.ts — same as phase 1 for sessions` — steps are read alone: repeat the exact content.

## Checklist

Before ending the turn, confirm:

- [ ] Every spec requirement maps to a phase; nothing beyond the goal (YAGNI)
- [ ] No placeholder patterns: TBD, "handle edge cases", "add validation", "same as phase N", code-free signatures
- [ ] Names and signatures identical across phases, folds, and the diagram
- [ ] Every phase named by its outcome with a Gate that proves it; every folded step has an exact path, marker, complete
      code where code changes, and a Verify with expected result
- [ ] Ordered by dependency; independent subsystems split into separate plans
- [ ] Structure in the diagram and code in the `:::details` folds, not duplicated in phase prose; :::mermaid only for
      sequence/state
- [ ] Every fork resolved up front via the ask-user tool, so the plan carries no open questions; critic dispatched where
      the host supports subagents; blocking findings fixed, one round only

## Handoff

On approve, the plan is the contract: execute it phase by phase, or hand it to the implementer. On reject, the notes
drive the rework loop (instruction 9). If the user wanted only the plan, stop here.
