# Delegating from a skill to a worker

How to phrase a skill body so the same delegation produces correct behavior on Claude Code, Codex, and Gemini. The
invocation surface diverges by host; the body shape stays the same when you phrase intent instead of naming the tool.
Worker file skeleton in [how-to-create-agents/TEMPLATE.md](../how-to-create-agents/TEMPLATE.md).

---

## The fundamental split

Two hosts let the model fire a worker mid-turn; one makes the user do it.

| Host        | Who fires the worker | Mechanism                                                                                                      |
| ----------- | -------------------- | -------------------------------------------------------------------------------------------------------------- |
| Claude Code | the model            | `Agent({ subagent_type: "<worker>", prompt: "…" })`                                                            |
| Codex       | the model            | Codex's subagent surface (built-ins `default`/`worker`/`explorer` or registered `~/.codex/agents/<name>.toml`) |
| Gemini      | the main agent       | the worker is exposed to the main agent as a tool named `<worker>`; user can force `@<worker> <prompt>`        |

On all three hosts the main/parent agent can fire the worker mid-turn — the user doesn't see the worker boundary unless
they explicitly invoked it. What Gemini blocks is **subagent→subagent** recursion: a worker can't call another worker. A
skill body that designs a tree of workers breaks on Gemini; a body that fans out from the parent ports.

---

## Where the worker file lives

On Claude and Gemini the worker ships bundled inside the plugin / extension. **Codex plugins cannot bundle subagents**
(as of May 2026); the worker file has to land at the user or project tier. Same `<worker>` name on all three so the
skill body stays portable — the host resolves the file from wherever it actually lives.

| Host   | Path                                                                                         | Format                                  |
| ------ | -------------------------------------------------------------------------------------------- | --------------------------------------- |
| Claude | `<plugin>/agents/<worker>.md`                                                                | Markdown + YAML                         |
| Codex  | `~/.codex/agents/<worker>.toml` or `.codex/agents/<worker>.toml` — **not plugin-bundleable** | TOML (body in `developer_instructions`) |
| Gemini | `<plugin>/agents/<worker>.md`                                                                | Markdown + YAML                         |

Codex distribution workaround: ship the `.toml` in the plugin's `assets/` and either document the manual copy step in
the plugin README, or wire a `SessionStart` hook that copies/symlinks from `${CLAUDE_PLUGIN_ROOT}/assets/<worker>.toml`
to `~/.codex/agents/<worker>.toml` on first run. (Or skip registration entirely — see the next section.)

---

## Generic worker — inline brief, no registered persona

Each host can spawn a "fresh sub-instance with no opinion of its own" — the persona travels in the brief rather than
living in a registered file. Useful when the worker logic fits in the brief, the worker is called only a handful of
times per session, and a separate per-host `.toml` / `.md` isn't worth maintaining.

| Host   | Built-in generic worker?                         | Setup                                           |
| ------ | ------------------------------------------------ | ----------------------------------------------- |
| Claude | yes — `general-purpose` is built-in              | none                                            |
| Codex  | yes — `default`/`worker`/`explorer` are built-in | none                                            |
| Gemini | no built-in — needs a shim                       | ship `<plugin>/agents/worker.md` (10-line file) |

For a portable skill body that names the worker the same way on every host, ship a thin `worker.md` shim on **both**
Claude and Gemini so all three hosts resolve `worker` deterministically. Codex doesn't need the shim — its built-in
answers to `worker` already, and Codex plugins can't bundle subagents anyway.

```yaml
# <plugin>/agents/worker.md  — shipped on Claude and Gemini; tools field uses host-native names
---
name: worker
description: |
  Generic worker. Accepts a self-contained brief and executes it cold-open.
  The brief carries the persona; this file is intentionally empty.
tools: [Read, Grep, Glob, Write, Edit, Bash] # Claude — Gemini ships its own with [read_file, grep_search, write_file, replace, run_shell_command]
---
You are a worker. Execute the brief in your input verbatim. Trust the brief literally; don't infer additional context.
Return exactly what the brief asks for.
```

Skill body stays the same prose on every host:

```markdown
## Step 3 — Security review

Delegate to the `worker` subagent with this brief:

You are an adversarial security reviewer. Read the staged diff at /tmp/staged.diff. For each changed function, list one
risk in the form `<file>:<line> — <issue>`. Stop at ten findings. If clean, return `OK.`
```

Host resolutions:

- **Claude** → `Agent({ subagent_type: "worker", prompt: "<brief>" })` against your shim
- **Codex** → spawns the `worker` built-in (or `default`/`explorer`) against the brief
- **Gemini** → calls the `worker` tool exposed by your shim

**Tradeoff:** the persona ships with every spawn (~150 tokens per call vs. ~30 for a registered worker). Pick this
pattern when calls per session are low and the persona is small. For high-frequency or persona-heavy workers, register a
custom file per host (see [Where the worker file lives](#where-the-worker-file-lives) above) — accepting that the Codex
distribution story is more involved.

---

## When to delegate at all

Reach for a worker when the skill needs a _different mind on the same problem_ — adversarial review, deeper reasoning,
isolated tool scope, parallel fan-out. Skip it when the work is small or shares context the parent already has;
invocation cost outweighs the benefit.

| Intent                                           | Why a worker fits                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| Adversarial review (security, perf, correctness) | Cold open avoids the parent's confirmation bias                              |
| Hard plan / deep reasoning                       | Heavier model for one step, not the whole skill                              |
| Strict tool scope (read-only, no Write)          | Per-worker sandbox without dropping the skill's tools                        |
| Parallel fan-out across N targets                | See [Parent Fan-Out + Stamped Results](../COMMON_PATTERNS.md#parent-fan-out) |

A skill that delegates everything is a skill that shouldn't exist — collapse it back into the worker, or make the worker
the skill.

---

## Phrase intent, never the tool

This is the central pattern. Phrase delegation as intent — the model on each host resolves to its native call.
Hard-coding `Agent(…)` makes the skill Claude-only; hard-coding `@worker` makes it Gemini-only.

```markdown
# Avoid — Claude-only literal

"Use the Agent tool: Agent({ subagent_type: 'payments-reviewer', ... })"

# Avoid — Gemini-only literal

"Tell the user to type @payments-reviewer."

# Prefer — intent, the host picks the call

"Delegate the security review to the `payments-reviewer` worker. Brief: <self-contained instruction>. Expect: numbered
findings."
```

Same body, three behaviors:

- **Claude** reads "delegate" → fires `Agent({ subagent_type: "payments-reviewer", … })`.
- **Codex** reads "delegate" → spawns the named subagent via Codex's subagent surface (built-ins
  `default`/`worker`/`explorer` or registered `.toml`); enabled by default.
- **Gemini** reads "delegate" → calls the `payments-reviewer` tool (the worker is exposed to the main agent as a tool of
  the same name). User-driven `@payments-reviewer` is an alternative path the user can take outside the skill.

Never name the host's primitive in the skill body. The verb is `delegate`; the noun is the worker name. The host fills
in the rest.

---

## Brief like a cold caller

The worker has no memory of the skill's turn. Pass file paths; the worker reads what it needs.

```markdown
# Avoid — inlines the file body into the brief

"Review this code:\n<4000 lines of source>"

# Prefer — pass the path; the worker reads what it needs

"Review src/payments.py:14-180. Focus on parse_amount and apply_discount."
```

A 4000-line file in a brief costs twice — once in the skill's context, once in the worker's input tokens. Worse on
Gemini: the user types or pastes the brief, and a brief stuffed with inlined source becomes unreadable.

---

## The skill ↔ worker contract

The skill briefs; the worker returns the declared shape. The brief is self-contained, the return is what the skill said
to expect.

```markdown
# In SKILL.md

## Step 3 — Security review

Delegate to the `payments-reviewer` worker with this brief:

Review the staged diff at /tmp/staged.diff. Focus on amount-overflow and rounding bugs in functions tagged `// money`.
Return numbered findings in the shape `<n>. <file>:<line> — <issue>`. If clean, return the single line `OK.`
```

The skill describes the _intent and the expected output shape_; the host decides the call. The worker's file body
specifies how to produce that shape (see [how-to-create-agents/TEMPLATE.md](../how-to-create-agents/TEMPLATE.md)).

---

## Tool scoping the worker

A worker should run with the smallest tool surface that gets the job done. Scope at the worker boundary, not in the
brief — prompt-only constraints leak.

| Host   | Where worker scope lives                                                 |
| ------ | ------------------------------------------------------------------------ |
| Claude | worker frontmatter `tools:` (or inherits parent)                         |
| Codex  | worker's `sandbox_mode = "read-only"` (or stricter)                      |
| Gemini | worker frontmatter `tools: [read_file, grep_search]` (Gemini tool names) |

A reviewer worker never needs `Write`. A gatherer never needs `Edit`. The skill body should not try to constrain the
worker's tools at call time; that belongs in the worker file.

---

## Consuming the worker's reply

The worker returns one message. The skill parses, merges, and decides what to include in its own reply — worker output
is not user-visible until the skill quotes it. See [BEST_PRACTICES.md — Reply shape](BEST_PRACTICES.md#reply-shape) for
the user-facing shape, and [COMMON_PATTERNS — Parent Fan-Out / Stamped Results](../COMMON_PATTERNS.md#parent-fan-out)
for the merge contract when N workers were invoked in parallel.

```markdown
# In SKILL.md — after N parallel worker invocations (Parent Fan-Out)

## Step 5 — Merge findings

Parse each worker reply as the declared JSON shape. Merge by `target` (every reply carries the input it processed — see
[Stamped Results](../COMMON_PATTERNS.md#stamped-results)). Quote the top three findings in the assistant reply; write
the full merged set to `${ROOT}/.preemdeck/<skill>/findings.md`. If any worker returned `verdict: "FAIL"`, the skill
verdict is FAIL.
```

Don't trust the worker's prose summary — parse the declared shape. A worker that says "looks good" without findings
either found nothing or hallucinated.

Gemini has two invocation paths and the merge step depends on which fired:

- **Main agent fires the worker** (skill-driven, the worker is exposed as a tool named `<worker>`): the reply comes back
  as a tool-call return the skill can parse, same as Claude and Codex. Default path for skill-internal delegation.
- **User types `@worker <prompt>`** (user-driven): the reply lands in the conversation directly, not in a tool-call
  return. If the skill body relies on user-driven invocation, instruct the user to "paste the worker's output back, then
  re-invoke the skill with `<continuation arg>`" — the merge step handles a user paste, not a return value.

Default to the main-agent path; reach for `@worker` only when the user must consciously trigger the worker (e.g. an
expensive review they should opt into).

---

## Quick checklist

```
Where workers live   ── plugin-bundled on Claude/Gemini; Codex installs at ~/.codex/agents/ or .codex/agents/ (no plugin tier)
Naming               ── same <worker> name across hosts; same file on Claude + Gemini (Codex via built-in or user-installed .toml)
Generic worker       ── Claude general-purpose · Codex worker · Gemini one shim file → inline brief carries persona
When to delegate     ── adversarial review · deep plan · strict scope · parallel fan-out
Phrase intent        ── "delegate to <worker>" — never hard-code the tool name
Briefing             ── paths, not contents; cold-open every call
Contract             ── skill briefs intent + output shape; worker returns the shape
Tool scope           ── at the worker file boundary, not in the brief
Consume              ── tool-call return when main agent fires; user paste when @worker (Gemini only)
Cross-link           ── worker file skeleton in how-to-create-agents/TEMPLATE.md
```
