### Spawning the fixer subagent

Use the `spawn_agent` tool. Required: `agent: "fixer"` and `instruction` (the full self-contained briefing). Optional:
`fork_turns: false` starts the subagent fresh; `fork_turns: true` (the default) inherits full session history but
rejects `agent_type` / `model` / `reasoning_effort` overrides.

### Batch fan-out

`spawn_agents_on_csv` spawns one worker subagent per CSV row, paired with a `report_agent_job_result` call from each
worker. Supports `max_concurrency`, `max_runtime_seconds`, and an `output_schema`.

### Asking the user questions

Use `ask_user_question` for structured clarification — single-choice or multi-choice options, plus an optional
custom-answer slot per question. Prefer this over free-form chat when you need a decision.

### Task tracking

`update_plan` — pass an array of `{step, status}` objects. Statuses: `pending` / `in_progress` / `done`. Update as work
proceeds.

### Built-in subagent types

`default`, `worker`, `explorer` — usable as `agent` values for `spawn_agent` without setup. Custom agents at
`~/.codex/agents/` or `.codex/agents/` are also addressable by their declared name.
