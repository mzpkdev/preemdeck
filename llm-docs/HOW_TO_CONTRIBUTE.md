# How to contribute to `agents/`

This directory holds reference docs that an LLM agent reads before doing work in this repo. Treat each file like a cheat
sheet — built for fast scanning, not cover-to-cover reading. This doc demonstrates the style it describes; if in doubt,
mimic its shape.

---

## Audience

The reader is another LLM, often loading the file mid-task with finite context. Optimize for:

- **Skimmability** — section headers tell the whole story; bodies confirm the details.
- **Section independence** — readers jump to one section, not start to end.
- **Density without bloat** — every line earns its place.

If a future LLM has to read three paragraphs before it can act, the doc has failed.

---

## Capture, then ask

When a session surfaces a new pattern, gotcha, or convention that would help the next LLM, raise it. Don't silently fold
it into the running task or quietly stash it in private memory — ask the user whether it belongs in `agents/`. The user
decides what compounds and what doesn't.

| Worth raising       | Skip                |
| ------------------- | ------------------- |
| New gotcha that bit | One-off bug         |
| Validated pattern   | Project state       |
| Host quirk          | Ephemeral context   |
| Cross-cutting rule  | Personal preference |

Memory is for you. `agents/` is the public contract for the next agent.

---

## Voice

Warm, direct, second-person plural ("How _we_ write…"). Friendly opener, then get out of the way.

| Trait       | Do                                  | Don't                                |
| ----------- | ----------------------------------- | ------------------------------------ |
| Warmth      | "How we write X here. Skim freely." | "This document defines the …"        |
| Directness  | "Never bare `except`."              | "It is generally recommended to …"   |
| Personality | Occasional flash ("Git remembers.") | Constant jokes; sterile manual prose |
| Person      | First-person plural / imperative    | Third-person passive                 |
| Hedging     | None                                | "may", "might want to", "consider"   |

One-liner aphorisms are welcome when they compress a rule: _"Trust the inside.", "Comments explain WHY, not WHAT."_

---

## Structure

Every file follows the same skeleton:

```
# Title                          ── H1, exactly one per file
1–2 line scope                   ── what this doc covers, target/version if relevant

---                              ── visual rhythm between sections

## Section                       ── H2 per topic
1–2 sentence framing             ── glue only — frame the artifact, don't replace it
artifact(s)                      ── table, code block, or diagram

---

## Quick checklist               ── compressed summary, always last
```

Rules:

- **One H1.** Title only.
- **H2 for sections, H3 sparingly** for sub-rules inside a section.
- **`---` between every section** (blank lines above and below).
- **No "in this section we will…"** — just start.
- **Sections stand alone.** A reader can land on any H2 and act.

---

## Visualization first

Prefer **tables**, **code snippets**, and **ASCII diagrams** over prose paragraphs. A 2-sentence framing before an
artifact is fine. A 6-sentence paragraph means the artifact should be doing the work.

| Tool          | Use for                                                 |
| ------------- | ------------------------------------------------------- |
| Table         | Taxonomies, mappings, comparisons (3+ rows)             |
| Bad/Good code | Rules with a clear wrong-form and right-form            |
| ASCII diagram | Layout, spatial structure, file trees, blank-line rules |
| Bullet list   | 3+ parallel rules with no shared columns                |
| Prose         | Glue only — never the load-bearing teaching surface     |

### Bad/Good convention

Label inside code comments. **Never use emojis** (unless the user explicitly asks):

````markdown
```ts
// Avoid
const fetch = (items) => {
  // ...
};

// Prefer
const fetch = (items: string[] = []) => {
  // ...
};
```
````

Two acceptable shapes:

- **Sequential** — `# Avoid` block, then `# Prefer` block, in the same fenced snippet.
- **Side-by-side** — only when both forms are short enough to read at a glance.

---

## Density rules

- Code blocks beat prose when teaching a pattern.
- Tables beat prose when comparing 3+ things.
- Don't restate the section title in the first sentence.
- Don't add disclaimers for edge cases nobody will hit. If an edge case matters, name it in one line.
- Cut any sentence that starts with "Note that…", "It's worth mentioning…", or "Generally speaking…".
- If a section grows past ~one screen, split it or move detail into a subsection.

---

## File organization

| Want to document…                          | File name                                        |
| ------------------------------------------ | ------------------------------------------------ |
| A language's coding standards              | `CODING_STANDARDS.md` (or `<LANG>_STANDARDS.md`) |
| Repo-level contribution rules for agents   | `HOW_TO_CONTRIBUTE.md`                           |
| A protocol or handshake between components | `<NAME>_PROTOCOL.md`                             |
| Architecture rationale and shape           | `ARCHITECTURE.md`                                |
| Working with a specific tool or API        | `<TOOL>_GUIDE.md`                                |

Conventions:

- **`UPPER_SNAKE_CASE.md`** for every filename.
- **One topic per file.** If a file passes ~400 lines, split it.
- **No duplication.** Two files explaining the same rule will drift. Cross-link instead.
- **Update before adding.** Reach for a new file only when the topic doesn't fit an existing one's scope.

---

## Examples are domain-neutral

Use simple, evergreen domains (cars, payments, dice) so the rule stays the focus. Avoid examples that bake in business
logic, project internals, or recently-shipped features — they age badly.

```ts
// Avoid — couples the rule to a specific feature
const fetchPreemdeckSlotStatus = (slotId: string): SlotStatus => { ... }

// Prefer — domain-neutral, the rule is the point
const fetch = (url: string, { timeout = 30 }: { timeout?: number } = {}): Uint8Array => { ... }
```

---

## Cheat sheet at the end

Close every doc with a compressed checklist in a fenced code block. Use `──` separators so it reads like a control
panel:

```
Naming     ── self-explanatory, no abbreviations, no magic numbers
Functions  ── small, single responsibility, stepdown order
Typing     ── public surface typed; `T | undefined` not `any`
```

The cheat sheet is the doc's table of contents and its TL;DR — a reader who only scans the bottom should still walk away
with the headline rules.

---

## Skeleton

Drop this template into a new file and fill it in:

````markdown
# <Topic>

<1–2 sentence scope. Target audience / version / surface area.>

---

## <First section>

<1–2 sentence framing.>

| col | col |
| --- | --- |
| ... | ... |

```code
# Avoid
...

# Prefer
...
```

---

## <Next section>

<1–2 sentence framing.>

```diagram
ascii layout here
```

---

## Quick checklist

```
Rule one     ── short verb phrase
Rule two     ── short verb phrase
Rule three   ── short verb phrase
```
````

---

## Quick checklist

```
Audience     ── another LLM, mid-task, finite context
Capture      ── surface new findings; ask before adding to agents/
Voice        ── warm, direct, first-person plural; no hedging
Structure    ── H1 + scope, H2 sections separated by `---`, cheat sheet last
Visualize    ── table / code / diagram first; prose is glue
Bad/Good     ── `# Avoid` and `# Prefer` in code comments, no emojis
Density      ── cut throat-clearing; cut "Note that…"; one screen per section
Files        ── UPPER_SNAKE_CASE.md, one topic each, update before adding
Examples     ── domain-neutral; the rule is the point, not the scenario
```
