# Subagent template

Fillable skeleton for a new subagent. Three host variants — only `name` and `description` port unchanged. Cross-host
details in [CLAUDE_CODEX_GEMINI.md](../CLAUDE_CODEX_GEMINI.md).

---

## Where the file lives

Claude and Gemini ship subagents bundled at the plugin / extension root. **Codex plugins cannot bundle subagents** (as
of May 2026 — `agents` is not in the plugin component list); the file has to land at the user or project tier instead.
Same `<name>` across hosts so the skill body addresses the worker the same way; the host resolves the file from wherever
it actually lives.

| Host   | Path                                                                                     | Format          |
| ------ | ---------------------------------------------------------------------------------------- | --------------- |
| Claude | `<plugin>/agents/<name>.md`                                                              | Markdown + YAML |
| Codex  | `~/.codex/agents/<name>.toml` or `.codex/agents/<name>.toml` — **not plugin-bundleable** | TOML            |
| Gemini | `<plugin>/agents/<name>.md`                                                              | Markdown + YAML |

Codex workaround for shipping a worker with a plugin: ship the `.toml` in the plugin's `assets/` and either instruct the
user to copy it, or wire a `SessionStart` hook that copies/symlinks from `${CLAUDE_PLUGIN_ROOT}/assets/<name>.toml` to
`~/.codex/agents/<name>.toml` on first run.

Alternative: skip the per-host registered file entirely and use the built-in generic worker (`general-purpose` on
Claude, `worker` on Codex, a thin shim on Gemini) — the persona lives in the brief instead of the file. See
[DELEGATING_FROM_SKILLS.md — Generic worker](../how-to-create-skills/DELEGATING_FROM_SKILLS.md#generic-worker--inline-brief-no-registered-persona).

---

## Frontmatter — what ports

Two universal fields. Everything else is host-specific.

| Field          | Claude                        | Codex                    | Gemini        |
| -------------- | ----------------------------- | ------------------------ | ------------- |
| `name`         | yes                           | yes                      | yes           |
| `description`  | yes                           | yes                      | yes           |
| `model`        | yes                           | yes                      | yes           |
| tool scope     | `tools:` (or inherits caller) | `sandbox_mode`           | `tools: [..]` |
| `temperature`  | —                             | —                        | yes           |
| `max_turns`    | —                             | —                        | yes           |
| `timeout_mins` | —                             | —                        | yes           |
| body lives in  | file body                     | `developer_instructions` | file body     |

Fields not in this list either belong on the parent skill or do not exist for subagents.

---

## Claude — `agents/<name>.md`

```yaml
---
name: reviewer
description: |
  Adversarial security pass on a staged diff. Returns findings as a numbered
  list with file:line refs. Use before merge. NOT for style review.
model: opus
---

You are a security reviewer. Read the staged diff and flag anything exploitable.

## Inputs
- A diff path handed in by the parent.
- The repository's root path.

## What to do
1. Read the diff.
2. For each changed function, list one risk in the form `<file>:<line> — <issue>`.
3. Stop at ten findings; truncate with a count if more exist.

## What NOT to do
- Don't review style, naming, or test coverage.
- Don't open files outside the diff's footprint.

## What to return
Numbered findings, one per line: `<n>. <file>:<line> — <issue>`.
If nothing found: the single line `OK.`
```

---

## Codex — `~/.codex/agents/<name>.toml` (user) or `.codex/agents/<name>.toml` (project)

```toml
name        = "reviewer"
description = "Adversarial security pass on a staged diff. Returns findings as a numbered list with file:line refs. Use before merge. NOT for style review."
model       = "gpt-5.3-codex"
sandbox_mode = "read-only"

developer_instructions = """
You are a security reviewer. Read the staged diff and flag anything exploitable.

## Inputs
- A diff path handed in by the parent.
- The repository's root path.

## What to do
1. Read the diff.
2. For each changed function, list one risk in the form `<file>:<line> — <issue>`.
3. Stop at ten findings; truncate with a count if more exist.

## What NOT to do
- Don't review style, naming, or test coverage.
- Don't open files outside the diff's footprint.

## What to return
Numbered findings, one per line: `<n>. <file>:<line> — <issue>`.
If nothing found: the single line `OK.`
"""
```

---

## Gemini — `<plugin>/agents/<name>.md` (or `.gemini/agents/<name>.md` standalone)

```yaml
---
name: reviewer
description: |
  Adversarial security pass on a staged diff. Returns findings as a numbered
  list with file:line refs. Invoke with @reviewer. NEVER trigger automatically.
model: gemini-2.5-pro
tools: [read_file, grep_search]
temperature: 0.2
max_turns: 10
timeout_mins: 5
---

You are a security reviewer. Read the staged diff and flag anything exploitable.

## Inputs
- A diff path handed in by the user via `@reviewer <path>`.
- The repository's root path.

## What to do
1. Read the diff.
2. For each changed function, list one risk in the form `<file>:<line> — <issue>`.
3. Stop at ten findings; truncate with a count if more exist.

## What NOT to do
- Don't review style, naming, or test coverage.
- Don't open files outside the diff's footprint.

## What to return
Numbered findings, one per line: `<n>. <file>:<line> — <issue>`.
If nothing found: the single line `OK.`
```

---

## System-prompt skeleton

Five sections, same order on every host. Drop in, fill the angle brackets.

```markdown
You are a <role>. <One-sentence purpose.>

## Inputs

- <thing the parent will hand in (path, not contents)>
- <surrounding context the agent needs to judge>

## What to do

1. <first concrete step>
2. <second concrete step>
3. <third concrete step>

## What NOT to do

- <known failure mode>
- <out-of-scope behavior>

## What to return

<exact output shape — format, sections, length budget>
```

---

## Vocabulary

Every rule in the body MUST carry an RFC 2119 keyword, uppercased — semantics, level-picking litmus, and dosing rules in
[RFC_2119_KEYWORDS.md](../RFC_2119_KEYWORDS.md). "What NOT to do" lines are MUST NOT / SHOULD NOT territory; "What to
do" steps stay plain imperative. "What to return" is where MUST earns its keep — the output contract is the one part the
parent parses.

```
MUST / MUST NOT       → absolute requirement / prohibition; no exceptions
SHOULD / SHOULD NOT   → strong default; deviate only with reason
MAY                   → genuinely optional
ALWAYS / NEVER        → every case, every turn
REQUIRED / OPTIONAL   → inputs, fields, arguments
```

---

## Invocation by host

Who invokes — and how — differs. The parent agent calls the subagent on Claude and Codex. The user calls it directly on
Gemini.

| Host   | Invoker      | Call                                                                                                           |
| ------ | ------------ | -------------------------------------------------------------------------------------------------------------- |
| Claude | parent agent | `Agent({ subagent_type: "reviewer", prompt: "..." })`                                                          |
| Codex  | parent agent | Codex's subagent surface (built-ins `default`/`worker`/`explorer` or registered `~/.codex/agents/<name>.toml`) |
| Gemini | user         | `@reviewer <prompt>` — user-side prefix only                                                                   |

A skill that hard-codes `Agent(...)` is Claude-only. On Gemini the subagent is never invoked by another agent — design
for direct user invocation.

---

## Quick checklist

```
Location     ── <plugin>/agents/ (Claude · Gemini); Codex not bundleable — install to ~/.codex/agents/ or .codex/agents/
Format       ── md+yaml on Claude/Gemini; TOML on Codex (body in developer_instructions)
Universal    ── name + description only; model widely supported; rest host-specific
Body shape   ── role · inputs · do · don't · return — in that order
Vocabulary   ── RFC 2119, uppercased: MUST / SHOULD / MAY / ALWAYS / NEVER / REQUIRED / OPTIONAL — see RFC_2119_KEYWORDS.md
Tool scope   ── tools: frontmatter (Claude) · sandbox_mode (Codex) · tools list (Gemini)
Invocation   ── Agent tool (Claude) · Codex subagent surface · @name prefix (Gemini)
```
