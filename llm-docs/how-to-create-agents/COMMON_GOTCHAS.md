# Common gotchas

Looks right, bites later. Most pain comes from the gap between hosts.

______________________________________________________________________

## File format diverges

Subagents are Markdown+YAML on Claude and Gemini, TOML on Codex. The body lives in `developer_instructions` on Codex —
not in the file body.

```yaml
# Claude / Gemini — body is the file content after frontmatter
---
name: reviewer
---
You are a reviewer…
```

```toml
# Codex — body is a TOML triple-quoted string
name = "reviewer"
developer_instructions = """
You are a reviewer…
"""
```

Copy-pasting a Claude `agents/<name>.md` into `.codex/agents/` with a renamed extension will not work — TOML can't parse
YAML frontmatter, and Codex won't find the body.

______________________________________________________________________

## Tool restriction unit differs

| Host   | Where scope lives                    | Failure mode if you forget        |
| ------ | ------------------------------------ | --------------------------------- |
| Claude | per-agent `tools:` frontmatter       | inherits the caller's full scope  |
| Codex  | per-agent `sandbox_mode`             | runs at caller's permission level |
| Gemini | per-agent `tools:` or `excludeTools` | full extension scope              |

A subagent that "shouldn't be able to write" needs `tools:` declared in its own frontmatter (Claude/Gemini) or
`sandbox_mode = "read-only"` on Codex. Don't try to scope at the caller — caller-side restrictions don't reach the
subagent's process.

______________________________________________________________________

## Invocation syntax differs

| Host   | Parent calls subagent via                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------- |
| Claude | `Agent` tool with `subagent_type: <name>`                                                            |
| Codex  | parent spawns Codex's subagent surface (`default`/`worker`/`explorer` built-ins or registered .toml) |
| Gemini | the subagent is exposed as a tool named `<name>` to the main agent; user can force `@<name>`         |

A skill that hard-codes `Agent(...)` is Claude-only. On Gemini the **main** agent can invoke a subagent (it's a tool of
the same name), but **subagent→subagent** recursion is blocked — and there is no peer-to-peer messaging on any host
except Claude.

______________________________________________________________________

## "Based on findings…" delegation

The subagent has no memory of the invoker's conversation — on any host. Phrases like "based on your findings, fix the
bug" push synthesis the invoker already did back onto the agent, which then re-discovers the wrong findings or re-does
the analysis from scratch. See [TEMPLATE.md](TEMPLATE.md#invocation-by-host) for host-specific call shapes.

```text
# Avoid — leans on conversation history the subagent can't see
invoke(reviewer, prompt="Based on the research, implement the fix.")

# Prefer — self-contained instruction with concrete coordinates
invoke(reviewer, prompt=(
    "Replace the `parse_amount` function at src/payments.py:42 with "
    "one that returns Decimal instead of float. Keep the signature."
))
```

If you understand the work, prove it in the prompt — file path, line, exact change.

______________________________________________________________________

## Description too vague

On Claude and Codex the parent LLM picks an agent by string-matching `description`. On Gemini the user picks from
`@name` completion. A vague description fails either way — random on Claude/Codex, useless completion on Gemini.

```yaml
# Avoid
description: An agent that helps with code.

# Prefer
description: |
  Returns the staged diff as a unified-diff string.
  Use before invoking the reviewer. NOT for unstaged changes.
```

Front-load the trigger phrase. Add an exclusion line if there's a near-neighbor agent that should win in some cases.

______________________________________________________________________

## Tool-name mismatch

Codex aliases `Edit` and `Write` to `apply_patch` in hook matchers — the matcher fires either way, but the payload's
`tool_name` field is always `apply_patch`. Subagent `tools:` allowlists and scripts that branch on `tool_name == "Edit"`
miss the call. Gemini uses `write_file` and friends.

```jsonc
// Avoid — Claude-only
{ "matcher": "Edit" }

// Prefer — covers all variants
{ "matcher": "(Edit|Write|apply_patch|write_file)" }
```

If the agent restricts tools by name, list every variant the host can emit.

______________________________________________________________________

## Frontmatter silently drops

Most subagent frontmatter is host-specific. Fields the host doesn't recognize parse but ignore — no error, no warning.

| Field           | Claude | Codex     | Gemini |
| --------------- | ------ | --------- | ------ |
| `temperature`   | —      | —         | yes    |
| `max_turns`     | —      | —         | yes    |
| `timeout_mins`  | —      | —         | yes    |
| `tools`         | —      | (sandbox) | yes    |
| `paths`         | yes    | —         | —      |
| `argument-hint` | yes    | —         | —      |

Smoke-test on every host the agent claims to support. A drop-on-Codex bug looks like the agent working fine until it
suddenly doesn't terminate.

______________________________________________________________________

## Inter-agent comms only on Claude

`TeamCreate`, `SendMessage`, `TeamDelete` are Claude-only (behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). Codex has
subagents (built-ins `default`/`worker`/`explorer` plus registered `.toml` files), enabled by default — but no
peer-to-peer protocol; messaging is parent-mediated. Gemini exposes subagents as tools to the main agent only; subagents
can't see or invoke each other.

```python
# Avoid — Claude-only peer messaging; won't port to Codex / Gemini
SendMessage({"to": "reviewer", "message": "ping"})
```

Design as fan-out / fan-in from the invoker — the parent on Claude/Codex, the parent or user on Gemini:

```python
# Claude — parent agent fans out via the Agent tool
results = [Agent({"subagent_type": "reviewer", "prompt": f"Review {t}"}) for t in targets]

# Codex — batch fan-out: model emits spawn_agents_on_csv; each worker calls
# report_agent_job_result exactly once with its result row
# (CSV holds per-row briefs; collection happens via the report calls)
```

```text
# Gemini — no parent layer; the user runs N invocations manually
> @reviewer Review src/a.py
> @reviewer Review src/b.py
```

A skill that orchestrates a "team" of agents is a Claude-only skill — document it or split the skill per host.

______________________________________________________________________

## Context bloat

Passing entire files in the prompt eats the agent's context window and the invoker's prompt cache.

```text
# Avoid — file contents inlined into the prompt
invoke(reviewer, prompt=f"Review this:\n{open('big.py').read()}")

# Prefer — pass the path; the subagent reads what it needs
invoke(reviewer, prompt="Review src/big.py. Focus on parse_amount.")
```

A 4000-line file in a prompt costs you twice — once in the invoker's context, once in the agent's input tokens.

______________________________________________________________________

## Name collisions across plugins

Subagent names are not namespaced on Claude or Codex. Two plugins shipping a `reviewer` agent clobber each other; load
order decides who wins.

```yaml
# Avoid — generic name in a shared marketplace
name: reviewer

# Prefer — prefix with the plugin
name: payments-reviewer
```

On Gemini the `@name` invocation is the user-visible syntax — a collision becomes a UX problem the user sees in
completions.

______________________________________________________________________

## Quick checklist

```
File format    ── md+yaml on Claude/Gemini; TOML on Codex (body in developer_instructions)
Location       ── <plugin>/agents/ (Claude · Gemini); Codex plugins can't bundle — install to ~/.codex/agents/ or .codex/agents/
Tool scope     ── per-agent tools: (Claude/Gemini) · per-agent sandbox_mode (Codex); never caller-side
Invocation     ── Agent tool (Claude) · Codex subagent surface · @name prefix (Gemini)
Briefing       ── cold-open; don't lean on parent context
Description    ── trigger first; vague gets ignored
Tool names     ── Edit ≠ apply_patch ≠ write_file; use regex matchers
Frontmatter    ── silent drops; smoke-test per host
Comms          ── inter-agent only on Claude
Context        ── pass paths, never inline file contents
Naming         ── prefix to avoid collisions
```
