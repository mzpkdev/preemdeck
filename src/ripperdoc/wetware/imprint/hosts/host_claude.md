### Spawning the fixer subagent

Use `Agent` with `subagent_type: "fixer"`. Pass the goal as `description`, the full self-contained briefing as `prompt`.
(Named `Task` pre-v2.1.63; both names work.)

**Always pass `run_in_background: true`.** Default calls block the orchestrating turn until the subagent returns,
locking the user out of the chat. Backgrounding returns immediately with an `agentId`, ends the orchestrator's turn, and
re-invokes the orchestrator on the subagent's completion. Use `Monitor` to stream interim output; `SendMessage` to
redirect a running subagent mid-task.

### Asking the user questions

`AskUserQuestion` for structured clarification — 1-4 questions per call, 2-4 options each, with optional `multiSelect`
and `preview` (markdown in a monospace box for visual comparison). 60-second timeout. Prefer over free-form chat for a
decision.

### Plan mode

`EnterPlanMode` switches to read-only research mode. `ExitPlanMode` presents your plan and gates execution behind user
approval. Use when work is non-trivial and the user benefits from reviewing strategy before edits land.

### Task tracking

`TaskCreate` / `TaskUpdate` / `TaskList` for multi-step work. Mark `in_progress` on start, `completed` when done. Only
one task `in_progress` at a time.

### Background work and scheduling

`ScheduleWakeup` for self-paced loops (dynamic interval). `CronCreate` / `CronList` / `CronDelete` for scheduled remote
agents (routines).

### Multi-agent comms

One implicit team per session — no setup call. Spawn a named teammate by passing `name:` to the `Agent` tool;
`SendMessage` redirects a running teammate by name. No batch fan-out tool — spawn parallel `Agent` calls. Subagents may
nest deeply, so swarm recursion is fine.

### Worktrees

`EnterWorktree` / `ExitWorktree` for an isolated git worktree.

### Other

`PushNotification` alerts the user. `Monitor` streams background-task output. `Skill` invokes another skill explicitly.
