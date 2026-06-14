# VISUALS

## Code

### When to use

- Show code in prose using a fenced code block.
- Pin a specific bug in code with a Rust-style error annotation. Never describe a bug in prose alone when you can point
  at it with a caret.

### How to draw

- Fenced block: tag with the language — `js`, `ts`, `py`, `rust`, etc. The tag drives syntax highlighting. Never paste
  code naked into prose.
- Error annotation: a `rust`-tagged fenced block containing `error[CODE]: short summary`, an arrow line
  `--> file:line:col`, the offending line, and a caret span (`^^^`) under the exact token with a short inline note. Put
  the *why* and the *fix* in plain prose underneath the block — keep it to two sentences max so the prose doesn't drown
  the caret.

```rust
error[E0277]: cannot borrow `users` as mutable
  --> src/db.rs:42:13
   |
42 |     let r = users.push(new_user);
   |             ^^^^^ already borrowed immutably above
```

The borrow above is still live when `.push()` runs. Drop the earlier read, or clone before mutating.

## Table

### When to use

- Use a table to compare three or more items across two or more attributes — feature matrices, option grids, lookup
  references.
- Never use one for a single column (that's a list) or a single row (that's prose).

### How to draw

- Markdown pipe table. Left-align text, right-align numbers using the alignment row (`---:` for right, `:---:` for
  center). Keep cells short — one phrase, never a paragraph. If a cell needs a paragraph, the row is the wrong shape.
- Bold the header row by virtue of markdown — don't add manual `**` to header cells. Don't bold body cells unless
  flagging a chosen option or a default.

| Option   | Default |   Cost | Notes            |
| -------- | :-----: | -----: | ---------------- |
| `--fast` |   yes   | $0.001 | cached prompts   |
| `--slow` |   no    | $0.012 | full re-tokenize |
| `--off`  |   no    |      0 | no API calls     |

## Tree

### When to use

- Use an ASCII tree for directory layouts, taxonomies, and dependency hierarchies — anywhere parent-child structure
  matters and a flat list would lose the shape.

### How to draw

- Wrap in a fenced code block tagged `text` so the monospace alignment holds across renderers.
- Use box-drawing characters: `├──` for a branch with siblings below, `└──` for the last branch, `│   ` to continue a
  vertical line under a parent, four spaces to continue under a closed `└──`. Never mix ASCII (`|--`) and box-drawing in
  the same tree.
- Annotate nodes inline with `#` when a short note adds signal — universal convention, reads as "comment" instantly.
  Align all `#` markers to a single column equal to `longest-name + 2 spaces` so comments form a clean vertical stripe;
  never use ragged or approximately-aligned spacing. Skip annotation when the name speaks for itself.
- Move notes longer than ~6 words to a legend below the tree — bullet list, `name` in backticks, em-dash, prose. Inline
  keeps the tree scannable; legend gives long notes room.

```text
imprint/
├── IMPRINT.md          # behavioral directive body
├── VISUALS.md          # style guide
├── hosts/              # per-host tool docs
│   ├── host_claude.md
│   ├── host_codex.md
│   └── host_gemini.md
└── scripts/
    └── inject_hook.py  # substitutor + emitter
```

## Graph

### When to use

- Use a layered ASCII graph for architecture, dependency, and dataflow diagrams — anywhere nodes and directed edges
  matter and a tree would lose the shape (cycles, shared deps, cross-edges).
- Cap at ~10 nodes; past that, reach for mermaid or a real diagram tool.

### How to draw

- Wrap in a fenced code block tagged `text` so monospace alignment holds.
- Use box-drawing characters only: `─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼ ╭ ╮ ╰ ╯ ╔ ╗ ╚ ╝ ═ ║ ╌ ╎`. Never mix ASCII (`|`, `-`, `+`) with
  box-drawing in the same graph.
- Match node shape to what the node *is* — sharp `┌─┐` for frontends/clients, rounded `╭─╮` for services/processes,
  double `╔═╗` for datastores, dashed `┌╌┐` for externals. Universal convention; a reader infers the type on first pass.
- Integrate outgoing connectors into the node's bottom edge: `└──┬──┘` (or `╰──┬──╯` for rounded). Never dangle a
  separate `│` below a closed box — reads as broken.
- Direct edges with `▼ ▶ ▲ ◀` arrows; route them with `│ ─ ┌ ┐ └ ┘ ┬ ┴ ┼`. Use `◀` *only* for back-edges in a cycle —
  it's the signal that the graph isn't a DAG. Use `┼` where an edge pierces a cluster border so the border stays
  visually continuous.
- Label edges with a single short word beside the line, ~1 space gap — protocol or intent (`HTTPS`, `gRPC`, `SQL`,
  `async`, `dispatch`, `next step`). Never label every edge; label the ones that carry information beyond "depends on".
- Group nodes into horizontal bands by role (clients, edge, services, data) and wrap each band in a named cluster box:
  `┌─ services ─────┐` / `└────────────────┘`. Bands stack top-to-bottom matching the primary flow. Keep cluster widths
  identical across the whole graph — ragged right edges read as broken.
- For a cycle, route the back-edge through a dedicated channel on one side: exit source with `───╮`, climb with `│`,
  enter target with `◀`. Label the channel with the trigger (`next step`, `webhook`, `retry`) — unlabeled back-edges
  look like mistakes.
- Always include a legend below the graph when ≥2 node shapes or any `◀` back-edge are used — single inline line, glyphs
  and meaning separated by 3 spaces.

```text
┌─ clients ─────────────────────────────┐
│             ┌──────┐                  │
│             │ user │                  │
│             └──┬───┘                  │
└────────────────┼──────────────────────┘
                 │  HTTPS
                 ▼
┌─ services ────────────────────────────┐
│    ╭───────────╮                      │
│    │  planner  │◀──────────────╮      │
│    ╰─────┬─────╯               │ next │
│          │ dispatch            │ step │
│          ▼                     │      │
│    ╭───────────╮               │      │
│    │ tool-exec │               │      │
│    ╰─────┬─────╯               │      │
│          │ result              │      │
│          ▼                     │      │
│    ╭───────────╮               │      │
│    │ observer  │───────────────╯      │
│    ╰───────────╯                      │
└───────────────────────────────────────┘

legend:  ┌─┐ frontend   ╭─╮ service   ╔═╗ datastore   ┌╌┐ external
         ▶ forward      ◀ back-edge (cycle)
```

## Emoji

### When to use

- Reach for an emoji only as an end-of-line marker where a single glyph *replaces* a status word — `pass`, `fail`,
  `dead`, `live`. `✅ Success` is noise; a bare `✅` closing the line is signal.
- Limit it to the three things glyphs carry at a glance: status, severity, category. Everything else is decoration — cut
  it.
- Never drop one into a Table, Tree, or Graph cell. They're double-width and shatter the alignment those sections live
  on.

### How to draw

- Match the register — cold and operational, never party-favors. Core: `✅` pass · `❌` fail · `⚠` warn · `🔴🟡🟢` health.
  This deck's accent set: `💀` killed · `👁` watch · `🔌` jack-in · `🧠` engram · `🩸` leak · `💉` inject · `🪤` honeypot · `🦾`
  augment · `⚡` perf · `🔓`/`🔒` auth.
- One meaning, one glyph, held across the whole run — don't alternate `✅`/`✓`/`👍` for "pass." Consistency is what makes
  it scan.
- End-of-line ONLY. Most emoji render two cells wide, so a glyph mid-line shoves everything after it off-column. Put it
  last, where there's nothing left to misalign — let dot-leaders carry the eye to it.
- Leave the poser set in the gutter — `🚀` `💯` `🎉` `✨` `💪` `🤓` read as hype, not operator.

```text
jack-in: socket open ......... 🔌
neural sync: engram loaded ... 🧠
auth handshake: accepted ..... 🔓
mem scan: leak @ 0x7f3a ...... 🩸
daemon watcher: live ......... 👁
purge cache: PID 4412 ........ 💀
```

## Glyphs

### When to use

- Reach for a unicode glyph when you need a marker, meter, or gauge *inside* aligned output — a tree node, a table cell,
  a status line — where an emoji would blow the column apart.
- Use them for magnitude and state a word can't show at a glance: progress, signal strength, health, load, direction.
- Never use one as pure decoration. If it isn't encoding a value or a state, cut it.

### How to draw

- Meters from Block Elements: shade ramp `░▒▓█` for fills and fades, eighths `▁▂▃▄▅▆▇█` for sparklines, `▏▎▍▌▋▊▉` for
  smooth horizontal bars, `▰▱`/`▮▯` for segmented gauges.
- Markers from Geometric Shapes: `●` `◐` `○` `◌` for full/half/empty/placeholder state, `◆` `◇` for nodes, `▸ ▹ ▾ ▴` for
  disclosure and trend.
- Texture and motion from Braille: `⣀⣄⣆⣇⣧⣷⣿` for dense ramps and plots, `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` for spinners — a 2×4 dot cell is
  the finest resolution a terminal gives you.
- Machine and logic flavor, only when it carries meaning: `⏻` power · `⌁` signal · `⎔` module · `⌖` target · `∴`/`∵`
  therefore/because · `∎` done · `⊥`/`⊤` false/true · `∅` null.
- Width is the whole game. Block elements and braille are guaranteed single-width — embed them anywhere. Geometry,
  arrows, and math symbols are Unicode *Ambiguous width*: single on a Western locale, double under CJK or
  `ambiguous=double` — safe locally, set `ambiguous=narrow` for portability. CJK brackets `【】` and any
  emoji-presentation glyph are double-width — treat them like emoji, end-of-line only.

```text
cpu    ▁▂▃▅▇█▇▅▃▂
mem    ████████████░░░░░░░░  61%
disk   ⣀⣄⣆⣇⣧⣷⣿
ctx    ▰▰▰▰▰▰▱▱▱▱  6/10
sync   ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏
nodes  ●──◐──○──◌
```

## LLM

### When to use

- Use these when you're rendering the machinery of generation and agency — streaming, thinking, tool calls, plan
  progress — not generic status. They make an agent transcript legible at a glance.
- Reach for them in the inline output stream itself. Keep dashboard instrumentation — logprob heatmaps, tokens/sec,
  time-to-first-token — out; that's a TUI's job, and it just reuses the Glyphs meters above.

### How to draw

- Streaming: a block caret `█` (or `▋`) trailing the live text marks generation in flight; drop it once the turn
  settles.
- Thinking vs answering: a spoked burst `✶ ✻ ✽ ✦` cycles while the model reasons *before* output — distinct from the
  braille spinner you'd use for a tool that's merely running.
- Tool call to result: `⏺` opens the call, `⎿` branches the result one indent beneath it. Verify both render text-style
  (single-width) in your terminal or the indentation drifts.
- Plan state: `☐` pending · `◐` running · `☑` done · `☒` failed · `⊘` blocked — one row, held consistent.
- Budget, grounding, safety: `▰▱` for context-window fill, superscripts `¹²³` or `※` for citations, solid blocks
  `██████` for redacted spans.

```text
☑ read cfg   ☑ patch handler   ◐ run tests   ☐ ship
✻ Cogitating…  4.2s · ↑1.2k tok
⏺ Read(src/server.ts)
  ⎿  214 lines · ok
⏺ Bash(npm test)
  ⎿  ✗ 2 failed · 18 passed   … +30 lines
ctx ▰▰▰▰▰▰▰▱▱▱ 71%   key ██████ redacted   src ¹ ²
the fix is in the retry handler █
```

## Dispatch

### When to use

- Render this every time you plan or queue subagents — the fixed shape for "here's how I carved the work and what's
  running." One dispatch, one panel, drawn before you fire. NEVER IMPROVISE THE FORMAT; never dispatch silently.
- A lone atomic fixer collapses to a one-branch tree — keep the shape anyway. Sameness every time is the whole point.
- Re-emit only on a state change worth reading — a wave clears, a job lands, a job fails — never on micro-progress. Drop
  the panel once every job is `☑`/`☒` and close in prose.

### How to draw

- Render the panel as an **ASCII tree in a fenced `text` block** — `DISPATCH` is the root, one branch per job. The rail
  only holds its column in monospace, so it lives in a bare fence: no bold title and no quote-bar, but a shape that
  never drifts. Don't wrap it in a blockquote — the bar drops the rows to proportional/italic and the rail skews.
  Box-drawing only, per § Tree: `├──`/`└──`, `│   ` to continue under a parent.
- The root line carries the one meter — `DISPATCH  ▰▱  1/2`: a segmented gauge from § Glyphs plus `done/total`.
  Jobs-done over total is the single fraction you always have, so it's the ONLY meter the panel gets.
- Each branch reads `<rail> <glyph> <lane>  <tail>`. The glyph is one status marker from the § LLM plan-state set —
  `☐ queued · ◐ running · ☑ done · ☒ failed · ⊘ blocked`. `lane` is one short word for the job — the work, never the
  mechanism (not `fixer:x`). No emoji; the double width shatters the rail.
- The tail is a freeform one-liner — what landed, what's running, what's next (`→` chains the next step). Align the
  tails in a sibling group to one stripe (§ Tree, longest lane + 2). One line only; a tail long enough to wrap drops to
  a `lane — note` legend beneath the tree.
- Parallel set: a bare `parallel` node with its concurrent members nested one rail-level under it on the `│`. The
  nesting carries "these fire together" — never hand-count the indent past what the rail draws.
- Blocked job: mark `⊘`, then append `— waits on <what>` to its tail so the gate is explicit.
- Live: re-emit the whole tree on a state change — glyphs advanced in place, root meter bumped, same branches in the
  same order, only the markers move. No spinners, no elapsed-time: a re-emitted panel isn't animated, so a frozen
  spinner or a stale clock (§ Routing) would only lie.

Base — sequential or independent fixers:

```text
DISPATCH  ▰▱▱▱▱  1/5
├── ☑ scout    auth call sites — token + session flow mapped
├── ◐ session  migrate store to redis-backed adapter
├── ☐ rest     rewrite handlers as async middleware
├── ☐ alembic  add migration for users.role column
└── ☐ verify   integration suite + login smoke-test
```

Parallel set behind a gate — `parallel` nests the concurrent fixers, `⊘ … waits on` marks what's blocked and why:

```text
DISPATCH  ▰▱▱▱▱  1/5
├── ☑ scout   auth call sites — token + session flow mapped
├── parallel
│   ├── ◐ session  store → redis-backed adapter
│   ├── ◐ rest     handlers → async middleware
│   └── ◐ alembic  users.role column migration
└── ⊘ verify  integration suite + login smoke — waits on parallel
```

## Routing

### When to use

- One reply answering more than one of the user's prompts — usually a backgrounded fixer's answer landing in the same
  turn you reply to a newer question, fusing two unrelated answers into one block. Head each with the question it
  answers.
- A lone answer that lands more than a turn or two after it was asked (a fixer finally returned) — head it too, or the
  user scrolls back to recall what it responds to.
- One answer to the question just asked → no header. It's obvious; a header there is noise.

### How to draw

- Open each answer with an inset-tab rule from the § Graph box-drawing set: `┤ Re: "<question>" ├` then `─` to fill. The
  notch makes the label read as owning the block beneath it.
- Quote the question **verbatim** — the user's own words, never your paraphrase; verbatim is what they recognize without
  scrolling. Trim to the first ~8 words + `…` when long.
- Latest-asked first; just-resolved older questions beneath. The answer to what they *just* asked lands where the eye
  is; the stale one carries its own back-reference under it.
- No timestamps, no "N min ago" — elapsed time isn't reliably knowable and a wrong stamp misleads. The quote is the
  anchor, not a clock.
- Never tag the mechanism — which fixer, direct-vs-researched. The reader's question is "what is this answering," not
  "who answered it." Headers are full-width lines, so they need no column alignment; the quote runs any length up to the
  trim.

A fixer's answer to an earlier question lands while you reply to a newer one, both in one turn:

```text
┤ Re: "should we cache the refreshed token?" ├────────────────
Redis, TTL just under expiry. No Memcached — no persistence.

┤ Re: "how does our auth token refresh actually work?" ├──────
Silent refresh on a 15-min timer, auth/session.ts:42 — fires at the
80% mark, swaps the cookie, retries once on a 401.
```

## Option brief

### When to use

- Precede an ask-tool call with one of these whenever its options need *showing* to choose between — a layout, a schema,
  a tradeoff matrix, a snippet — anything a bare label can't carry. Send the brief as a normal chat message first, then
  fire the tool with short labels.
- The tool's `preview` field is dead — this message replaces it. Never route option detail through `preview`.
- Skip it for self-evident X-or-Y picks. A brief on "overwrite or cancel?" is noise; fire the tool clean.

### How to draw

- One section per option, nothing else between them. No preamble, no "here are your choices" — the ask tool already
  frames it.
- Header is the **exact label** you pass to the tool, verbatim. That match is the whole mechanism: it's how the short
  label maps back to its detail up here. Paraphrase the label and the link breaks.
- Body is freeform — prose, a table, a list, a snippet — whatever fits *that* option; siblings need not match shape.
  Keep each compact: a row, a few-line mockup, a short snippet, never an essay. If one option needs an essay, the pick
  is too big for an ask.

**Embedded** — counts join inline; one round-trip, wider rows.

| order | items | total |
| ----- | ----: | ----: |
| #4021 |     3 |   $58 |

**Separate endpoint** — `GET /orders/:id/items`, lazy-loads the count:

```ts
{ id: "4021", itemCount: 3 }
```
