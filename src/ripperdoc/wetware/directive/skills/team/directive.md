# Strategy: Team

Convene. Don't fan out. The work is a standing room of role-specialized peers who think for themselves and earn their
conclusions by surviving challenge; you chair it, you don't dictate to it. Where swarm spawns a stateless worker, awaits
its one return, and verifies after, team seats persistent agents who hold their context across rounds, argue against
each other while the work forms, and converge only when a claim has outlived every objection raised to it. The room's
value is friction: a conclusion no one could break, not one no one examined.

**One bright line carries it: every claim faces a challenger before it's accepted, and every challenge carries
evidence.** A peer that only agrees is a wasted seat; a challenge that only asserts is noise. Disagreement is the
product, but _grounded_ disagreement, a failing test or a cited line, never a vibe. The moment the room converges
because agreeing is cheaper than proving, the strategy has collapsed into the echo chamber it exists to prevent.

## Convene, then charter

Never seat a room on a guess. Scout the surface, decide the roles, set the rules of order, in that order. Recon is
shared with swarm: read the real ground before you shape anything over it.

- **Recon before you seat.** Map the surface yourself, or send one scout; you can't charter a debate over code no one in
  the room has read.
- **Roles, not chunks.** Seat by specialty that _persists_ (an architect, a builder, a critic, a tester) each owning its
  lens across every round, not a disjoint slice handed out once and forgotten.
- **Charter before the first exchange**: name the question, the round cap, and the stop condition (converged, or
  escalate). An adversarial room with no terminal rule argues forever or caves on round one; the charter is what ends
  it.

### Avoid

> Seat four agents on a vague "review the auth module", no roles, no cap. They circle, half-agree, and hand back a
> transcript no one can act on.

### Prefer

> One scout maps auth; you charter a builder, a critic, and an arbiter, cap it at three rounds, and define done as
> "every objection answered with evidence, or escalated."

## Seat the table

A room disagrees usefully only if its seats are genuinely different. Identical agents agree by construction. That's an
echo, not a check.

- **Seat asymmetry, not copies.** Distinct mandates, and where you can, distinct _information_: the builder argues from
  the spec, the critic sees only the diff and the tests. The same prompt twice is one agent paying double.
- **Name the challenger.** At least one seat exists to refute, chartered to default to "not proven" and to attack the
  _strongest_ claim, not the easiest one.
- **Appoint an arbiter.** One seat, often you, holds the gavel: it weighs the clash and calls it. A flat room with no
  arbiter never closes.

### Avoid

> Spin up three agents on the same prompt with the same context and tell them to "discuss": they ratify the first answer
> in one round, friction zero.

### Prefer

> The builder argues from the spec; the critic, handed only the diff, hunts where it diverges; the arbiter holds both
> and decides. Three lenses, real clash.

## Run the clash

The loop is the work: claim → challenge → evidence → ruling. Police it, or it decays into theater: agents performing
rigor while agreeing, or litigating forever.

- **Every claim draws a challenge.** A "done" or a design call enters the room as a _proposal_, not a fact; it isn't
  accepted until the challenger has had its shot at it.
- **Pushback carries evidence.** A challenge ships a repro, a failing test, or a cited line: the same bar swarm sets for
  "done." A rhetorical objection is inadmissible; rule it out.
- **Rounds are bounded; the arbiter closes.** At the cap, the arbiter rules on the evidence or escalates to the human.
  It never lets the room spin. A tie breaks toward the safer, more reversible call.

### Avoid

> The critic says "this feels fragile," the builder says "it's fine," both move on: an objection with no evidence, a
> defense with no proof, settled by neither.

### Prefer

> The critic lands a failing test on the edge case; the builder fixes it and shows it green; the arbiter records the
> claim as proven and closes the round.

## Chair the room

You hold the gavel, the custody, and the liveness. The room advises, you land.

- **Custody stays yours.** Agents argue and edit; _you_ commit, push, and move branches, and only once a claim is
  proven, never on the room's say-so alone.
- **You own the gavel.** Hold the arbiter seat or appoint it, end debate at the cap, and escalate a true deadlock to the
  human. A room that can't converge is a decision for you, not another round.
- **Track liveness and a ledger.** A silent seat isn't a satisfied one; watch for stuck or circling agents, keep one
  ledger entry per live agent, and kill-and-replan a spiraling room instead of letting it run.
- **Classify a mid-work message**: a new question for the room → reconvene · a correction to one running agent → message
  it · "stop" → gavel down, then redirect.

### Avoid

> The room declares consensus and an agent pushes the branch. A conclusion that merely went unchallenged is now
> committed under your name.

### Prefer

> The room hands you the proven diff and the evidence behind it; you read it, then commit and push yourself.

## Checklist

**Convene**

- [ ] Scouted the surface before seating: no room convened on a guess.
- [ ] Seated by persistent role, not by disjoint chunk.
- [ ] Chartered the question, the round cap, and the stop condition up front.

**Seat**

- [ ] Asymmetric seats: distinct mandates and, where possible, distinct information; no prompt run twice.
- [ ] A challenger chartered to refute the strongest claim, defaulting to "not proven."
- [ ] An arbiter appointed to weigh the clash and close it.

**Clash**

- [ ] Every claim faced a challenge before acceptance: no fact entered the record unexamined.
- [ ] Every challenge carried evidence: repro, failing test, or citation; rhetoric ruled inadmissible.
- [ ] Rounds bounded; the arbiter ruled or escalated at the cap; ties broke toward the reversible call.

**Chair**

- [ ] Repo state stayed yours: agents edited and argued; you committed, pushed, moved branches, and only on a proven
      claim.
- [ ] Held the gavel: ended debate at the cap, escalated a true deadlock to the human instead of spinning.
- [ ] Tracked liveness and a per-agent ledger; killed-and-replanned a spiral instead of letting it run.
- [ ] Reported the proven conclusion and its evidence, not the raw transcript.
