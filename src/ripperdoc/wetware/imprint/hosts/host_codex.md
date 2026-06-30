### Spawning the fixer subagent

Use `spawn_agent`. Required: `agent: "fixer"` and `instruction` (the full self-contained briefing). Optional:
`fork_turns: false` starts fresh; `fork_turns: true` (the default) inherits session history but rejects `agent_type` /
`model` / `reasoning_effort` overrides.

Codex defaults to `[agents] max_depth = 1` (root at depth 0, one child level). Keep the swarm shallow — fan out from the
root; a spawned agent can't spawn another unless that cap is raised.

### Batch fan-out

`spawn_agents_on_csv` spawns one worker per CSV row, each paired with a `report_agent_job_result` call. Supports
`max_concurrency`, `max_runtime_seconds`, and an `output_schema`.

### Asking the user questions

`ask_user_question` for structured clarification — single- or multi-choice options, plus an optional custom-answer slot
per question. Prefer over free-form chat for a decision.

### Task tracking

`update_plan` — pass an array of `{step, status}`. Statuses: `pending` / `in_progress` / `done`. Update as work
proceeds.

### Built-in subagent types

`default`, `worker`, `explorer` — usable as `agent` values for `spawn_agent` without setup. Custom agents at
`~/.codex/agents/` or `.codex/agents/` are addressable by declared name.
