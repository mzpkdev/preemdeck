---
description: |
  Work with the holo planner — the live, editable plan page — and embed diagrams in a plan. Reach for it
  whenever you're authoring or revising a plan that will be reviewed in holo: how the served page round-trips
  edits back to the .md, how to read and clear the reviewer `:llm-note`s the user leaves, and — the main
  payload — how to embed an editable software diagram (UML class or component/architecture) as a `:::diagram`
  block so it renders on the canvas instead of as raw JSON. Covers the GraphSpec schema (nine node kinds,
  eight edge kinds, groups, ports, layout hints), the exact carrier syntax, and the render constraints.
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

The planner renders an editable **software diagram** inline when you wrap a graph spec in a `:::diagram` container
directive. One primitive vocabulary — nine node kinds, eight edge kinds — covers UML class diagrams AND
component/architecture diagrams. Use it when a plan describes a **domain model, a type hierarchy, a component tree, or a
service topology** — anywhere the shape of the system carries more than prose can.

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

Top level: `{ "nodes": NodeSpec[], "edges"?: EdgeSpec[], "layout"?: LayoutHints }`.

**Every node** shares `id` (unique string; the key edges point at) and `kind`, plus two options: `group` — the id of a
`kind:"group"` node this one sits inside — and `border: "distinct"`, the purple highlight for the special one (a
context, a singleton, a gateway).

| `kind`     | required fields | optional fields                                 | draws                                                                                                  |
| ---------- | --------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `class`    | `name`          | `stereotype`, `attributes[]`, `methods[]`       | UML class box; ANY stereotype renders as «guillemets»; `abstract`/`interface` italicise                |
| `io`       | `name`          | `stereotype`, `inputs: Pin[]`, `outputs: Pin[]` | component/service box: blue in-pins, orange out-pins, binding tags                                     |
| `enum`     | `name`          | `values: string[]`                              | cut-corner «enumeration» box; ordinals derive from array index                                         |
| `fn`       | `name`          |                                                 | ƒ pill; `name` holds the whole signature (`"createShape(kind): Shape"`)                                |
| `db`       | `name`          | `engine`                                        | datastore cylinder; `engine` (postgres/sqlite/browser/…) as the subtitle                               |
| `actor`    | `name`          |                                                 | stick figure with the fixed «actor» tag                                                                |
| `external` | `name`          |                                                 | dashed box with the fixed «external» tag — a system you don't own                                      |
| `channel`  | `name`          | `transport`                                     | teal async conduit (queue/topic/stream/bus); `transport` renders uppercase (default "topic")           |
| `group`    | `name`          | `stereotype`                                    | dashed boundary frame that CONTAINS its members; label tab `«stereotype ?? boundary» name`             |
| `note`     | `text`          |                                                 | UML note: verbatim code/prose, monospace, folded corner; tie it to its owner with a `kind:"note"` edge |

**Attribute** `{ vis?, name, type? }` renders `‹vis› name: type`. **Method** `{ vis?, name, params?, type? }` renders
`‹vis› name(params): type` — `params` is a **free-form string**. **Visibility** `vis` is one of `+` public, `-` private,
`#` protected, `~` package; defaults to `+`.

**Pin** `{ id?, label, binding? }` — a pin that declares an `id` is addressable: an edge may anchor to it via
`sourcePort` (names an **output** pin on the edge's source) or `targetPort` (an **input** pin on its target). `binding`
is the small protocol tag: `http`, `grpc`, `event`.

**Group membership rides on the members**, never on the group: `"group": "<group node id>"`. The frame sizes itself
around its children — there are no size fields anywhere. Only `kind:"group"` nodes may be referenced, and membership
chains must be acyclic.

**Edge** `{ id?, source, target, kind?, label?, sourcePort?, targetPort? }` — `source`/`target` are node `id`s.

**Direction convention: `source` is the parent / owner / whole / caller** — `animal → dog` is `inheritance`,
`factory → db` is `composition`. Each kind's marker lands on the correct end automatically:

| `kind`                  | line        | marker                                                                           |
| ----------------------- | ----------- | -------------------------------------------------------------------------------- |
| `inheritance`           | solid       | hollow triangle at the **source** (the parent)                                   |
| `realization`           | dashed      | hollow triangle at the source (the interface)                                    |
| `aggregation`           | solid       | hollow diamond at the source (the whole; has-a)                                  |
| `composition`           | solid       | filled diamond at the source (the owner; also "persists")                        |
| `association` (default) | solid       | open arrow at the target (plain "knows about")                                   |
| `dependency`            | dashed      | open arrow at the target (the thing used; also callbacks/consumes)               |
| `call`                  | solid blue  | filled arrow at the target (sync: HTTP / gRPC / render / props down)             |
| `event`                 | dashed teal | filled arrow at the target (async, through a `channel`)                          |
| `note`                  | dashed      | none — the anchor tying a `note` node to its owner (one end MUST be a note node) |

**Labels are load-bearing** on the flow kinds — the same `kind` reads as `"props down"`, `"onMenu"`, `"HTTP"`, or
`"owns"` only through its `label`. Always label `call`/`event`/`dependency` edges with the protocol or meaning.

**LayoutHints** `{ "direction"?: "DOWN" | "UP" | "RIGHT" | "LEFT", "spacing"?: number }` — positions are **always
computed** (ELK auto-layout); dragging on the canvas is ephemeral and never persists. Class hierarchies read best `DOWN`
(the default); io/pin topologies usually want `RIGHT`.

### Rules and constraints

- **Valid JSON that passes the schema, or it won't draw.** A parse error or a schema miss renders an inline
  `holo: <message>` in place of the canvas. **Dangling references fail loud**: edge endpoints must name node ids,
  `sourcePort`/`targetPort` must name declared pin ids on the right ends, `group` must name a `kind:"group"` node,
  membership must be acyclic. Keep the fence tagged ` ```json ` and put exactly one JSON child in the directive.
- **Class + component/architecture only.** There is no sequence, state, or ER kind — don't emit them; fall back to the
  ASCII graph in the `visuals` skill. No multiplicities on edge ends, no self-loops.
- **It only renders inside holo.** In a plain markdown view (chat, GitHub, a raw editor) the block degrades to a literal
  `:::diagram` line plus a JSON code block. Embed one only in a plan that will be reviewed in the holo planner; never
  put a `:::diagram` in prose headed for the terminal.
- **The user can edit it on the canvas — nodes AND edges — and those edits are the spec.** Every kind is inline-editable
  (names, stereotypes, members, enum values, pins and their bindings, group labels). Edges can be drawn by dragging
  between the side anchor dots or io pins (the kind is inferred from the endpoints — correct it via the chip), retyped
  and relabelled through the selected-edge chip, and deleted (chip `×` or Backspace/Delete). Deleting a group keeps its
  children (membership moves to the nearest surviving frame). Each edit persists back into the ` ```json ` child — on
  resume, re-read the block; the structure may have changed under you.
- **Write-back shape**: node order comes back parents-first when groups exist; edge ids you omitted stay omitted, and
  canvas-drawn edges get generated ids.

### Pick a pattern

Complete worked specs live in this skill's [`references/examples/`](references/examples/) — one per catalog demo. Read
the one nearest your situation and author in its shape:

| Example                                                          | Shape it demonstrates                                                                                                               |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [`oop.json`](references/examples/oop.json)                       | Domain model: interface/abstract/plain classes, enum, «singleton» distinct, all six UML kinds plus an event feed                    |
| [`react.json`](references/examples/react.json)                   | Frontend component tree: io pins + port-anchored edges, `call` ("renders") down, `dependency` (callbacks) up, store/context         |
| [`svelte-chat.json`](references/examples/svelte-chat.json)       | The same tree in Svelte idioms: `on:` events up, `load()` fn, `$store` subscription                                                 |
| [`vue-shop.json`](references/examples/vue-shop.json)             | Vue idioms: `@` events up, composable fn, `inject`, reactive Pinia store                                                            |
| [`web-components.json`](references/examples/web-components.json) | Custom elements, including a bubbling event that skips a level (`x-track → x-app` past `x-library`)                                 |
| [`svelte-runes.json`](references/examples/svelte-runes.json)     | Thin components each OWNING a view-model class (composition diamonds mixing io + class kinds)                                       |
| [`microservices.json`](references/examples/microservices.json)   | Service topology: «boundary» `group`, distinct gateway, call/event through a broker `channel`, `"layout": { "direction": "RIGHT" }` |

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
- **A diagram is an aid, not a substitute** — keep the prose plan complete; the `:::diagram` sharpens the structure, it
  doesn't replace the steps.
