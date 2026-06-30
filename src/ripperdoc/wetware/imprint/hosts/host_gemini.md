### Spawning the fixer subagent

Exposed as a tool under its own name — call `fixer` with the full self-contained briefing.

### Subagent recursion is blocked

Inside a subagent, the runtime hides agent tools — even with `tools: ["*"]`. A `fixer` is a leaf: it cannot spawn
sub-fixers. Decomposition must be **flat** — the main thread fans out directly; no nested swarms. Plan all delegation
from the main thread.

### Asking the user questions

`ask_user` for structured clarification — 1-4 questions per call. Types: `choice` (2-4 options, with optional
`multiSelect` that auto-adds an "All the above" choice), `text` (free-form), `yesno` (confirmation). `header` capped at
16 characters. Prefer over free-form chat for a decision.

### Plan mode

`enter_plan_mode` switches to read-only research (filesystem read-only; Markdown writes restricted to the plans dir).
`exit_plan_mode` presents the plan and gates execution behind user approval. Use when work is non-trivial and the user
benefits from reviewing strategy before edits land.

### Task tracking

`write_todos` — pass a complete task list of `{description, status}`. Statuses: `pending` / `in_progress` / `completed`
/ `cancelled` / `blocked`. Only one task in `in_progress` at a time.

### Built-in subagents

Callable by name as tools: `generalist` (general-purpose), `cli_help` (Gemini CLI questions), `codebase_investigator`
(architecture and dependencies), `browser_agent` (web browsing — disabled by default).

### Memory across sessions

No dedicated memory tool — persist cross-session state as tiered Markdown via `write_file` / `replace` into `GEMINI.md`.
