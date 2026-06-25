# Best practices

Patterns that produce reliable subagents across Claude, Codex, and Gemini. A subagent runs cold — no memory of the
parent's turn. Brief it like a colleague who walked in late.

---

## Single responsibility

One agent, one job, one return shape. If the description needs two "and"s, split the agent.

```yaml
# Avoid — three jobs jammed into one
name: helper
description: Reviews code, runs tests, and drafts the PR description.

# Prefer — one verb, one return
name: reviewer
description: Adversarial security review of staged diff. Returns numbered findings.
```

The parent LLM picks an agent by reading `description`. Overloaded descriptions confuse selection on every host.

---

## Naming

Role-of-intent (noun describing the actor — `reviewer`, not `review`). Kebab-case. Ten characters or fewer when
possible. The name shows up in error messages on Claude/Codex and in `@name` invocation on Gemini. Skills name the verb
(`review`, `scan`); agents name the actor (`reviewer`, `scanner`).

| Good        | Why        |
| ----------- | ---------- |
| `reviewer`  | clear role |
| `validator` | one job    |
| `gatherer`  | one job    |
| `planner`   | clear role |

| Avoid       | Why                                      |
| ----------- | ---------------------------------------- |
| `helper`    | nothing concrete                         |
| `do-stuff`  | not invocable by `description` match     |
| `agent-v2`  | version in the name breaks rename safety |
| `reviewer2` | reads like a placeholder                 |

Prefix with the plugin when shipping to a shared marketplace — `name: payments-reviewer`, not `name: reviewer`. Subagent
names are not namespaced on Claude or Codex; two plugins shipping `reviewer` collide.

---

## Description triggers

On Claude and Codex the parent LLM picks an agent by string-matching `description`. On Gemini the user picks from
`@name` completion. Front-load the trigger phrase; state exclusions explicitly.

```yaml
# Avoid — vague, useless to both parent LLMs and human readers
description: A helpful agent for code work.

# Prefer — trigger first, scope next, exclusion last
description: |
  Security review of staged diff. Returns numbered findings.
  Use before merge. NOT for style review or test failures.
```

Subagents on Gemini never auto-invoke — they're user-driven via `@name`. The description is what tells the user _when_
to pick this agent, so write it for a human reader too.

---

## Prompt density

Brief the agent on the contract, not the implementation. Tell it what to return, not how to think.

```markdown
# Avoid — leans on parent context the agent doesn't have

"Based on the findings, decide what to do."

# Prefer — concrete inputs, concrete return

"Read the diff at /tmp/staged.diff. For each function changed, list one risk in the form `file:line — risk`. Return at
most ten lines. If none, return `OK.`"
```

Lead with the contract: _inputs, steps, return shape_. Cut every sentence that doesn't shape one of those.

---

## Model selection

Match the model to the task's depth. Heavier models are slower and cost more. Don't default to opus.

| Task shape                    | Claude | Codex               | Gemini           |
| ----------------------------- | ------ | ------------------- | ---------------- |
| Quick lookup, regex, format   | haiku  | gpt-5.4-mini        | gemini-2.5-flash |
| Mid-depth review, simple plan | sonnet | gpt-5.3-codex       | gemini-2.5-pro   |
| Adversarial review, hard plan | opus   | gpt-5.3-codex-spark | gemini-2.5-pro   |

Override per-agent with the `model` field. The default is the parent's model.

---

## Tool scoping

Least privilege. The mechanism differs per host; keep them in sync.

| Host   | How to scope                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------- |
| Claude | per-agent `tools:` (or `disallowedTools:`) in the subagent's own frontmatter                               |
| Codex  | per-agent `sandbox_mode = "read-only"` (or stricter)                                                       |
| Gemini | per-agent `tools: [read_file, grep_search]` in the subagent's own frontmatter (Gemini names, not Claude's) |

```yaml
# Gemini — explicit allowlist; everything else denied (Gemini tool names, not Claude's)
tools: [read_file, grep_search]
```

```toml
# Codex — read-only sandbox; no Edit, no Write
sandbox_mode = "read-only"
```

A reviewer never needs `Write`. A gatherer never needs `Edit`. Scope down at the boundary, not in the prompt.

---

## Briefing

The subagent has no memory of the invoker's turn — on any host. Every invocation is a cold open, whether the invoker is
a parent agent (Claude / Codex) or the user typing `@name` (Gemini). See [TEMPLATE.md](TEMPLATE.md#invocation-by-host)
for the host-specific call shapes; the principle below is universal.

```text
# Avoid — no context, leans on prior conversation
invoke(reviewer, prompt="Now do the review")

# Prefer — self-contained brief
invoke(reviewer, prompt=(
    "Review the diff at /tmp/staged.diff. "
    "Context: this is a payment-handling change; we're worried about "
    "amount-overflow and rounding bugs. Skip style nits."
))
```

Include: the task, the inputs (paths, not pasted file contents), any constraint that affects judgment. _Trust the
inside, brief the outside._

---

## Output contract

Declare the return shape in the system prompt. Parsing fails silently when the agent decides to be helpful.

```markdown
## What to return

A JSON object with these keys:

- findings: array of { file, line, issue }
- verdict: "PASS" or "FAIL" Nothing else. No preamble, no closing remark.
```

Pick one of three shapes — don't mix:

| Shape               | Use when                                             |
| ------------------- | ---------------------------------------------------- |
| Single-line verdict | Boolean question — `OK.` / `FAIL: <why>`             |
| Structured JSON     | Caller (parent) will programmatically merge results  |
| Markdown sections   | Caller (parent or Gemini user) will read it as prose |

Default to JSON for parents (Claude / Codex); markdown for Gemini users who read `@name` output directly.

Cap the return — verdicts at one line, lists at ten items (twenty max), markdown at one screen (≈ 40 lines). A 200-line
subagent report is almost always a 10-line subagent report with prose around it; the parent's context budget pays for
every excess line.

On failure, hold the contract — name the cause as `FAIL: <reason>` rather than returning a silent `Done.` The parent
needs something to act on. Parents should never trust intent reports either: verify by parsing, or by re-reading the
underlying state.

---

## Quick checklist

```
Responsibility ── one job per agent; split if description has two "and"s
Naming         ── verb-of-intent, kebab-case, prefix with plugin
Description    ── trigger first, scope next, exclusion last
Density        ── brief the contract: inputs, steps, return shape
Model          ── match depth; opus / pro is not the default
Tools          ── least privilege; mechanism per host
Briefing       ── cold-open every call; pass paths, not contents
Output         ── declare shape; parser, not intent
```
