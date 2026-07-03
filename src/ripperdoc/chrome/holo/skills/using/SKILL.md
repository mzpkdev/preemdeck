---
description: |
  Work with the holo planner — the live, editable plan page — and embed diagrams in a plan. Reach for it
  whenever you're authoring or revising a plan that will be reviewed in holo: how the served page round-trips
  edits back to the .md, how to read and clear the reviewer `:llm-note`s the user leaves, and — the main
  payload — how to embed an editable UML class diagram as a `:::diagram` block so it renders on the canvas
  instead of as raw JSON. Covers the GraphSpec schema, the exact carrier syntax, and the render constraints.
user-invocable: true
---

# holo:using

A manual for **holo** — a dev server that renders an agent's plan `.md`/`.mdx` as a live, editable page (MDXEditor) and
writes every edit back to the **same file on disk**. The plan file stays the canonical artifact: the user edits the
rendered page, each change is debounced and POSTed to the server, the server writes it into the `.md`, and you re-read
that file when you resume at the plan gate. There is no separate live channel — the file _is_ the channel.

## How the planner reaches the user

You don't launch it. On the interactive path (`HOLO_PLANNER: true` in `~/.preemdeck/preemdeck.json`), the `idea`
plugin's plan hook fires the instant you exit plan mode, serves the plan file over a local port, and opens it in a
JetBrains web-preview tab **beside the approve/reject gate**. So the plan you present becomes a document the user reads,
annotates, and edits while they sit at the gate — and any change is already in the file by the time you resume.

Two consequences to plan around:

- **The user's edits are the plan.** When you resume, re-read the plan file rather than trusting your own last draft —
  the user may have rewritten prose, added notes, or restructured the diagram in place.
- **Round-trip-safe carriers only.** MDXEditor drops HTML comments on its import→export cycle. Anything that must
  survive a user edit rides as a **remark directive** (`:llm-note`, `:::llm-guide`, `:::diagram`), which the editor
  clones and re-emits verbatim. Don't smuggle agent state in comments; use the directives below.

## Reviewer notes: `:llm-note`

The user pins feedback by selecting text on the page and typing a note. It persists in the file as an inline directive
wrapping the selected span:

```text
:llm-note[the exact text the user selected]{note="do this differently"}
```

- **Read them on resume** — grep the plan for `:llm-note` (the greppable token) before you act on the plan.
- **Address each, then remove its directive** — keep the wrapped text, drop the `:llm-note[…]{…}` wrapper, and make the
  change the note asks for. A plan you resume with `:llm-note`s still in it is a plan you haven't finished reading.
- You rarely author these yourself; the page's right-click UI creates them. Your job is to consume them.

## The `:::llm-guide` preamble

The plan hook prepends a hidden `:::llm-guide` container directive to every interactive plan. It renders as **nothing**
on the page (invisible to the user) but survives the round-trip, so its instructions to you stay in the file. Read it —
it tells you what to do with the notes and how to close the loop. Leave it in place; it's idempotent across
reject→re-present.

## Embedding a diagram: `:::diagram`

The planner renders an editable **UML class diagram** inline when you wrap a graph spec in a `:::diagram` container
directive. This is the one visual holo draws for you; use it when a plan describes a **domain model, a type hierarchy,
or the classes/interfaces you're about to build** — anywhere the shape of the types carries more than prose can.

### The carrier

A `:::diagram` container directive wrapping **one ` ```json ` fenced child** that holds the spec. Emit it exactly this
shape:

````text
:::diagram

```json
{
  "nodes": [
    {
      "id": "animal",
      "kind": "class",
      "name": "Animal",
      "stereotype": "abstract",
      "attributes": [{ "vis": "#", "name": "name", "type": "string" }],
      "methods": [{ "vis": "+", "name": "speak", "type": "void" }]
    },
    {
      "id": "dog",
      "kind": "class",
      "name": "Dog",
      "methods": [{ "vis": "+", "name": "speak", "type": "void" }]
    }
  ],
  "edges": [{ "id": "e1", "source": "animal", "target": "dog", "kind": "inheritance" }]
}
```

:::
````

The spec lives in a **code child, not a `{spec="…"}` attribute** — a container directive's attribute block must be
single-line, so multi-line pretty JSON in an attribute breaks the syntax. The ` ```json ` child round-trips
byte-faithfully; an attribute would not. Keep the blank lines around the fence as shown.

### The GraphSpec schema

Top level: `{ "nodes": NodeSpec[], "edges"?: EdgeSpec[] }` (`edges` defaults to `[]`).

**Node** — only the `class` kind exists today:

| Field        | Required | Value                                                                        |
| ------------ | -------- | ---------------------------------------------------------------------------- |
| `id`         | yes      | Unique string; the key edges point at.                                       |
| `kind`       | yes      | `"class"` (the only kind for now).                                           |
| `name`       | yes      | The class name shown in the header.                                          |
| `stereotype` | no       | `"abstract"` \| `"interface"` \| `"enumeration"` — drives the header render. |
| `attributes` | no       | Array of members (below); defaults to `[]`.                                  |
| `methods`    | no       | Array of members (below); defaults to `[]`.                                  |

**Attribute** `{ vis?, name, type? }` renders `‹vis› name: type`. **Method** `{ vis?, name, params?, type? }` renders
`‹vis› name(params): type`. `params` is a **free-form string**, e.g. `"dx: number, dy: number"` — not a structured
array.

**Visibility** `vis` is one of `+` public, `-` private, `#` protected, `~` package; defaults to `+`.

**Edge** `{ id?, source, target, kind? }` — `source`/`target` are node `id`s. `kind` is one of `association` (default),
`dependency`, `inheritance`, `realization`, `aggregation`, `composition`.

### Rules and constraints

- **Valid JSON that passes the schema, or it won't draw.** A parse error or a schema miss renders an inline
  `holo: <message>` in place of the canvas. Unknown `kind`, a missing `name`/`id`, a bad `vis` glyph — all fail the
  block. Keep the fence tagged ` ```json ` and put exactly one JSON child in the directive.
- **Class diagrams only.** There is no flowchart, sequence, state, or ER kind — don't emit them. For those, fall back to
  the ASCII graph in the `visuals` skill. `stereotype` already covers abstract / interface / enumeration as class boxes.
- **Edge `kind` round-trips but doesn't render distinctly yet.** Every edge currently draws as a plain line — no
  arrowheads or diamonds distinguish `inheritance` from `composition`. Set `kind` correctly anyway (it's the record of
  intent, and the markers land later), but don't rely on the glyph to read the relationship today.
- **It only renders inside holo.** In a plain markdown view (chat, GitHub, a raw editor) the block degrades to a literal
  `:::diagram` line plus a JSON code block. Embed one only in a plan that will be reviewed in the holo planner; never
  put a `:::diagram` in prose headed for the terminal.
- **The user can edit it on the canvas, and those edits are the spec.** They can rename a class or member, edit params
  and types, cycle a member's visibility, and add or remove members; each edit persists back into the ` ```json ` child.
  (Edges aren't canvas-editable yet.) On resume, re-read the block — the structure may have changed under you.

## Serving a plan by hand

Outside the plan-gate flow, serve any plan file directly to review or edit it in the browser:

```bash
"$HOME/.preemdeck/preemdeck-runtime" "$HOME/.preemdeck/src/ripperdoc/chrome/holo/apps/planner/serve.ts" <plan.md> [--port <n>] [--open]
```

It prints `holo: ready url=<url> mdx=<path>`, then blocks; edits on the page write straight back to `<plan.md>`. Stop it
with Ctrl-C, or pass `--kill-on-disconnect` to have it self-reap when the tab closes. To edit a **bare graph on its
own** (a `.json`, not embedded in a plan), the sibling `apps/diagram/serve.ts` serves the same canvas over
`/__holo/graph`.

## Notes

- **The file is the source of truth**, not your draft and not the page — always re-read the plan `.md` on resume.
- **Directives over comments** for anything that must survive a user edit.
- **A diagram is an aid, not a substitute** — keep the prose plan complete; the `:::diagram` sharpens the type
  structure, it doesn't replace the steps.
