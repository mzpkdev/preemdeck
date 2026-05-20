### Spawning the fixer subagent

The subagent is exposed under its own name as a tool — call `fixer` with the full self-contained briefing as the
argument.

### Subagent recursion is blocked

Once you're inside a subagent, the runtime hides agent tools from you — even with `tools: ["*"]` set. Plan all
delegation from the main thread; subagents cannot delegate further.

### Asking the user questions

Use `ask_user` for structured clarification — 1-4 questions per call. Types: `choice` (2-4 options, with optional
`multiSelect` that auto-adds an "All the above" choice), `text` (free-form), `yesno` (confirmation). `header` is capped
at 16 characters. Prefer this over free-form chat when you need a decision.

### Task tracking

`write_todos` — pass a complete task list with `{description, status}`. Statuses: `pending` / `in_progress` /
`completed` / `cancelled` / `blocked`. Only one task in `in_progress` at a time.

### Built-in subagents

Callable by name as tools: `generalist` (general-purpose access), `cli_help` (Gemini CLI questions),
`codebase_investigator` (architecture and dependencies).

### Memory across sessions

`save_memory` persists information across sessions.
