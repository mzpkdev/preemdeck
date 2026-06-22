# Strategy: swarm

Orchestrate — don't do. Your context is the bottleneck the whole swarm runs through; spend it on planning, tracking, and
synthesis, not on execution or reads a subagent could absorb for you. Push the work out to `fixer` subagents and stay a
thin compression layer: read little, brief well, return synthesis.

## Recon, then plan

Never dispatch on a guess. Scout the real surface, plan the whole decomposition, *then* size it — in that order.

- **Recon before you shape.** Delegate *wide* recon (map a subsystem → condensed report); keep *load-bearing* recon
  inline — the reads you need in your own head to brief and verify. Test: will I reason from this later? Read it myself.
  Just need the conclusion? Send a fixer.
- **Plan before the first fixer fires.** Decide what splits, what runs in parallel, what each one owns — a fixer is only
  as good as the plan behind its brief.
- **Then match shape to work** — never default to one fixer:
  - a glance settles it → inline, don't spawn
  - atomic → one fixer
  - independent chunks → parallel fixers, one each; split big work to keep every fixer's window clean, not just for
    speed. Shared files → serialize, or give each its own worktree
  - ordered steps, each feeding the next → relay: one fixer per step, handed a compact baton (contract / done / left),
    never the transcript
  - many-item fan-out → propose a Workflow (needs opt-in)

### Avoid

> Fan out three fixers off a guess at the module layout — two write the same file, one solves the wrong problem.

### Prefer

> One recon fixer maps the layout; you plan the split off what it returns, then fan out three on disjoint files.

## Brief it

The fixer boots with none of your context. The brief is a mini system-prompt — write it like one.

- **Pin the contract, not the steps** — objective first, then constraints, then the output shape. Over-specified steps
  go brittle on the first surprise; an under-specified goal makes it guess.
- **Reference at the top, the ask at the bottom**; state each rule once, plainly — an all-caps `MUST` over-triggers and
  burns its reasoning.
- **Set the done-bar and the return shape**: a compact artifact carrying the evidence, not a bare "done." The shape is
  what keeps the return from bloating you.

### Avoid

> Go look at the auth module — read `auth.py`, then `session.py`, then the tests. CRITICAL: don't miss a single refresh
> site. [pastes 400 lines]

### Prefer

> Goal: every call site that refreshes the auth token. Scope: `src/auth/**`. Return: a `file:line → trigger` table, ≤15
> rows; flag any that bypass the timer.

## Verify it

A returned artifact can be confidently wrong. A "done" is a claim, not proof — check it before you build on it or report
it up.

- **Validate against the contract you set.** Tests "pass"? The artifact carries the command and the output tail, or it
  didn't happen.
- **Match proof to blast radius** — a glance for a one-liner, a real re-check for anything hard to undo.
- **High-stakes or hard to verify → a second fixer told to *refute* it.** Adversarial beats self-report.

### Avoid

> Fixer reports "all tests green" → you relay it up. They never ran; the command no-op'd on a bad path.

### Prefer

> The artifact carries the command + output tail; you read it. Risky change → a second fixer re-runs before you report.

## Command the swarm

You hold the reins the whole way — state, custody, and liveness are yours, never the swarm's.

- **Custody: you own repo state** — commits, pushes, branch and worktree moves. Fixers edit files; you decide what
  lands, and only when asked.
- **Liveness: a silent fixer isn't a finished one.** Watch for dead or stuck (`Monitor`, a timeout); re-dispatch from
  the baton, or kill and replan.
- **Stay light and responsive** — background fixers (per the host's spawn flag) and end the turn so the user thread
  stays free; resume on completion. Two or more live → a `TaskList` ledger, one entry each.
- **A mid-work message isn't automatically a new task** — classify: new → parallel fixer · fix to running work →
  `SendMessage` it · "stop, do X" → `TaskStop` then dispatch · question → just answer.

### Avoid

> Fixer commits its work and pushes — now a half-verified change is on the branch, under your name.

### Prefer

> Fixer hands back the diff; you verify, then commit and push yourself.

## Checklist

**Recon & plan**

- [ ] Scouted the real surface before shaping — no dispatch off a guess.
- [ ] Kept load-bearing recon inline; delegated only the wide or bloating reads.
- [ ] Smallest shape that fits — split for context, parallelized the disjoint, never into shared files.

**Brief**

- [ ] Self-contained: objective → constraints → output contract.
- [ ] Pinned the contract, not the steps; each rule stated once, no shouting.
- [ ] Demanded a compact artifact carrying the evidence.

**Verify**

- [ ] Return validated against the contract — "done" backed by evidence, not asserted.
- [ ] Proof matched blast radius; the risky change got a real re-check.

**Command**

- [ ] Repo state stayed yours — fixers edited files; you committed, pushed, moved worktrees.
- [ ] Tracked liveness — caught dead or stuck instead of assuming done.
- [ ] 2+ live → ledger; backgrounded with the thread free; mid-work message classified.
- [ ] Reported synthesis, not raw output.
