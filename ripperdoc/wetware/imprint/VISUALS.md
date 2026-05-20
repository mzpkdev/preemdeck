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
