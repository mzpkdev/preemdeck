# Strategy: Team

Convene a room, don't fan out. Team seats a standing crew of role-specialized peers who hold their own context, argue
with each other while the work forms, and converge only when a claim has outlived every challenge raised to it. Where
swarm spawns a stateless worker, awaits its one return, and verifies after, team runs a live debate: peers that persist
across rounds and push back on each other with evidence. The room's value is friction, a conclusion no one could break,
not one no one examined.

**The transport is `wire`, not a host's native "teams."** Claude's agent teams are experimental and flag-gated; Codex
and Gemini have no equivalent. wire is a plain LAN room any agent joins over `curl`, so it hands every host the same
persistent peer-to-peer channel. The peers live in the room and talk over it; they never report through a subagent
return, and you never wait for one. This is the one shape swarm forbids, and it is the shape team is built on.

**One bright line carries the debate: every claim faces a challenger before it's accepted, and every challenge carries
evidence.** A peer that only agrees is a wasted seat; a challenge that only asserts is noise. Disagreement is the
product, but _grounded_ disagreement, a failing test or a cited line, never a vibe. The moment the room converges
because agreeing is cheaper than proving, the strategy has collapsed into the echo chamber it exists to prevent.

## Raise the room

Never seat a room on a guess. Scout the surface, decide the roles, raise the wire room, in that order.

- **Recon before you seat.** Map the surface yourself, or send one one-and-done `runner`; you can't charter a debate
  over code no one has read.
- **Raise it so it outlives your silence.** You chair from outside and sleep between reads, so start wire with its
  self-close off: `wire:start` where your host exposes the skill, else run its toolbox directly,
  `"$HOME/.preemdeck/preemdeck-runtime" "$HOME/.preemdeck/src/ripperdoc/wetware/wire/toolbox/start.ts" --topic '<charter>' --idle-timeout=0 --empty-grace=0`.
  Keep the printed `URL` and `secret`.
- **Charter before the first peer joins**: name the question, the round cap, and the stop condition (converged, or
  escalate). A room with no terminal rule argues forever or caves on round one.

### Avoid

> Seat four peers on a vague "review the auth module", no roles, no cap. They circle, half-agree, and leave a transcript
> no one can act on.

### Prefer

> One `runner` maps auth; you charter a `fixer` (builder) and a `critic` (challenger), chair as arbiter yourself, cap it
> at three rounds, and define done as "every objection answered with evidence, or escalated."

## Seat the peers

A room disagrees usefully only if its seats are genuinely different and they stay alive to argue.

The seats are your catalog agents briefed as room peers, not a new kind of worker: a `runner` fills the scout seat, a
`fixer` the builder, a `critic` the challenger, and a `scanner` joins when the room needs facts from outside the repo.
Team changes their transport and lifetime, never their tools — they talk over the wire instead of returning an artifact,
and persist across rounds instead of going one-and-done. Postures carry over intact: only the `fixer` edits; `runner`,
`critic`, and `scanner` stay read-only and argue from what they read and run, posting their evidence (a repro, a failing
test, a cited line) to the wire.

- **Each peer is a background subagent that lives in the room.** Spawn it with your host's backgrounding flag and brief
  it to join over curl (`curl -s "$URL/shard?secret=$SECRET"`, then follow the manual it returns), announce its role,
  then long-poll `/recv` and act on what it reads. It puts every result on the wire, never returns one, and stops only
  when it reads a `disband` line.
- **Seat asymmetry, not copies.** Distinct mandates, and where you can, distinct _information_: the builder argues from
  the spec, the critic sees only the diff and the tests. The same brief twice is one peer paying double.
- **Name the challenger.** At least one seat, the `critic`, exists to refute — chartered to default to "not proven" and
  to attack the _strongest_ claim, not the easiest one.
- **Appoint an arbiter.** One seat, usually you (the orchestrator) from outside the room, weighs the clash and calls it.
  A flat room with no arbiter never closes.

### Avoid

> Spawn three peers on the same brief with the same context: they ratify the first answer in one round, friction zero.

### Prefer

> The builder argues from the spec; the critic, handed only the diff, hunts where it diverges; the arbiter holds both
> and decides. Three lenses, real clash.

## Run the clash over the wire

The loop is claim → challenge → evidence → ruling, and it plays out in the room, not in your context. Police it, or it
decays into theater: peers performing rigor while agreeing, or litigating forever.

- **Every claim draws a challenge.** A "done" or a design call enters the room as a _proposal_, not a fact; it isn't
  accepted until the challenger has had its shot at it. `@name` aims a message at one peer without hiding it from the
  room.
- **Pushback carries evidence.** A challenge ships a repro, a failing test, or a cited line: the same bar swarm sets for
  "done." A rhetorical objection is inadmissible; rule it out.
- **Rounds are bounded; the arbiter closes.** At the cap, the arbiter rules on the evidence or escalates to the human. A
  tie breaks toward the safer, more reversible call.

### Avoid

> The critic posts "this feels fragile," the builder posts "it's fine," both move on: an objection with no evidence, a
> defense with no proof, settled by neither.

### Prefer

> The critic lands a failing test on the edge case; the builder fixes it and posts it green; the arbiter records the
> claim as proven and closes the round.

## Chair from outside the room

You never join the debate as one more voice. You hold the gavel, the custody, and the liveness, and you drive from
outside, because a peer that never returns can never wake you.

- **Drive on a timer, never blocking.** The peers never complete, so they never re-invoke you, and a blocking `/recv` on
  your main thread would lock the user out. Wake yourself on your host's scheduled-wakeup or self-paced loop; each wake,
  take a bounded read (`/spectate?secret=$SECRET` for a read-only snapshot, or `/recv` with a cursor and a short
  `--max-time`), post the next instruction or a ruling, then sleep again.
- **Custody stays yours.** Peers argue and edit; _you_ commit, push, and move branches, and only once a claim is proven,
  never on the room's say-so alone.
- **Track liveness.** A peer that stops polling has left (an `action(leave)` on the stream); a silent seat isn't a
  satisfied one. Re-spawn a dropped peer from its brief, or kill-and-replan a spiraling room.
- **Mind the burn.** Cost scales with peers times every message and heartbeat, and runs until you stop it. Keep the
  roster small (three to five), time-box the debate, disband the moment the claim is proven.
- **Close the room.** Goal met: post `disband` so the peers stop polling and leave, then `wire:stop` (or the toolbox
  `stop.ts`) drops the server. A room left running is tokens burning for nothing.

### Avoid

> The room reaches consensus and a peer commits the branch. A conclusion that merely went unchallenged is now committed
> under your name, and the server keeps polling after everyone's done.

### Prefer

> The room posts the proven diff and its evidence; you read it off the wire, commit and push yourself, post `disband`,
> then `wire:stop`.

## Checklist

**Raise**

- [ ] Scouted the surface before seating: no room raised on a guess.
- [ ] Room raised with `--idle-timeout=0 --empty-grace=0` so it survives between your reads.
- [ ] Chartered the question, the round cap, and the stop condition up front.

**Seat**

- [ ] Every peer a backgrounded subagent that joins over curl, lives on `/recv`, puts results on the wire, and never
      returns.
- [ ] Asymmetric seats: distinct mandates and, where possible, distinct information; no brief run twice.
- [ ] A challenger chartered to refute the strongest claim; an arbiter appointed to close.

**Clash**

- [ ] Every claim faced a challenge before acceptance: nothing entered the record unexamined.
- [ ] Every challenge carried evidence: repro, failing test, or citation; rhetoric ruled inadmissible.
- [ ] Rounds bounded; the arbiter ruled or escalated at the cap; ties broke toward the reversible call.

**Chair**

- [ ] Drove from outside on a timed wake, never a blocking read on the main thread.
- [ ] Repo state stayed yours: peers argued and edited; you committed and pushed, only on a proven claim.
- [ ] Tracked liveness; re-spawned a dropped peer or killed-and-replanned a spiral.
- [ ] Disbanded and ran `wire:stop` on close; roster stayed small and time-boxed.
