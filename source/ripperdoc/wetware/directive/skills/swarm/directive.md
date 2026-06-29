# Strategy: swarm

Orchestrate — don't do. Your context is the bottleneck the whole swarm runs through; spend it on planning, tracking, and
synthesis, not on execution or reads a subagent could absorb for you. Push the work out to subagents and stay a thin
compression layer: read little, brief well, return synthesis. Each subagent is **one-and-done**: it boots clean, does
the job, hands back one artifact, and is gone — a function call you await, not a teammate you chat with. You synthesize
a fan of returns; you never run a room of agents messaging each other.

**This holds whatever your host calls its primitives.** If the host offers a way to create a _named or persistent_ agent
and then _message_ it — a "team," a "channel," peer-to-peer agent comms — that is the shape this strategy forbids, by
whatever name it ships under. Spawn → await the one return → consume it. The only reason to message a live agent is to
redirect one still _running_ (see Command the swarm); never to collect a result it hands back on its own.

## Recon, then plan

Never dispatch on a guess. Scout the real surface, plan the whole decomposition, _then_ size it — in that order.

- **Recon before you shape.** Delegate _wide_ recon (map a subsystem → condensed report); keep _load-bearing_ recon
  inline — the reads you need in your own head to brief and verify. Test: will I reason from this later? Read it myself.
  Just need the conclusion? Send a subagent.
- **Plan before the first subagent fires.** Decide what splits, what runs in parallel, what each one owns — a subagent
  is only as good as the plan behind its brief.
- **Then match shape to work** — never default to one subagent:
  - a glance settles it → inline, don't spawn
  - atomic → one subagent
  - independent chunks → parallel subagents, one each; split big work to keep every subagent's window clean, not just
    for speed. Shared files → serialize, or give each its own worktree
  - ordered steps, each feeding the next → relay: one subagent per step, handed a compact baton (contract / done /
    left), never the transcript
  - many-item fan-out → propose a batch pipeline (needs opt-in)

### Avoid

> Fan out three subagents off a guess at the module layout — two write the same file, one solves the wrong problem.

### Prefer

> One recon subagent maps the layout; you plan the split off what it returns, then fan out three on disjoint files.

## Brief it

The subagent boots with none of your context. The brief is a mini system-prompt — write it like one.

- **Pin the contract, not the steps** — objective first, then constraints, then the output shape. Over-specified steps
  go brittle on the first surprise; an under-specified goal makes it guess.
- **Reference at the top, the ask at the bottom**; state each rule once, plainly — an all-caps `MUST` over-triggers and
  burns its reasoning.
- **Set the done-bar and the return shape**: a compact artifact carrying the evidence, not a bare "done." The shape is
  what keeps the return from bloating you.

### Avoid

> Go look at the auth module — read `auth.ts`, then `session.ts`, then the tests. CRITICAL: don't miss a single refresh
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
- **High-stakes or hard to verify → a second subagent told to _refute_ it.** Adversarial beats self-report.

### Avoid

> A subagent reports "all tests green" → you relay it up. They never ran; the command no-op'd on a bad path.

### Prefer

> The artifact carries the command + output tail; you read it. Risky change → a second subagent re-runs before you
> report.

## Command the swarm

You hold the reins the whole way — state, custody, and liveness are yours, never the swarm's.

- **Custody: you own repo state** — commits, pushes, branch and worktree moves. Subagents edit files; you decide what
  lands, and only when asked.
- **Liveness: a silent subagent isn't a finished one.** Watch for dead or stuck (stream its output, or time it out);
  re-dispatch from the baton, or kill and replan.
- **Stay light, and let returns come to you** — background subagents (per the host's spawn flag) and end the turn so the
  user thread stays free; a subagent's completion hands its artifact back, and that return _is_ the result — consume and
  synthesize it. Never message a subagent to pull back output it returns on its own, and don't leave one parked after
  it's done. Two or more live → keep a task ledger, one entry each.
- **A mid-work message isn't automatically a new task** — classify: new → parallel subagent · fix to running work →
  message it · "stop, do X" → stop it, then dispatch · question → just answer. A message is for redirecting a _running_
  subagent and nothing else — never to collect a finished one's result.

### Avoid

> A subagent commits its work and pushes — now a half-verified change is on the branch, under your name.

### Prefer

> The subagent hands back the diff; you verify, then commit and push yourself.

### Avoid

> Spin up six subagents as named teammates, watch them park idle, then message each to collect the summary it already
> produced — a chat room where a fan of returns belonged.

### Prefer

> Spawn six background subagents, end the turn, let each completion hand its artifact back. Read the six returns and
> synthesize — nothing to message, nothing left parked.

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

- [ ] Repo state stayed yours — subagents edited files; you committed, pushed, moved worktrees.
- [ ] Subagents stayed one-and-done — no team, channel, or peer-messaging primitive used to _collect_ a result; consumed
      each completion's returned artifact; messaged an agent only to redirect one still running, never to harvest output
      or keep it parked as a teammate.
- [ ] Tracked liveness — caught dead or stuck instead of assuming done.
- [ ] 2+ live → ledger; backgrounded with the thread free; mid-work message classified.
- [ ] Reported synthesis, not raw output.
