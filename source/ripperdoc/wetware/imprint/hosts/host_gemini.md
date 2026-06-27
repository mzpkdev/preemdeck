### Spawning the fixer subagent

Exposed as a tool under its own name — call `fixer` with the full self-contained briefing.

### Subagent recursion is blocked

Inside a subagent, the runtime hides agent tools — even with `tools: ["*"]`. Plan all delegation from the main thread;
subagents cannot delegate further.

### Asking the user questions

`ask_user` for structured clarification — 1-4 questions per call. Types: `choice` (2-4 options, with optional
`multiSelect` that auto-adds an "All the above" choice), `text` (free-form), `yesno` (confirmation). `header` capped at
16 characters. Prefer over free-form chat for a decision.

### Task tracking

`write_todos` — pass a complete task list of `{description, status}`. Statuses: `pending` / `in_progress` / `completed`
/ `cancelled` / `blocked`. Only one task in `in_progress` at a time.

### Built-in subagents

Callable by name as tools: `generalist` (general-purpose), `cli_help` (Gemini CLI questions), `codebase_investigator`
(architecture and dependencies).

### Memory across sessions

`save_memory` persists information across sessions.
