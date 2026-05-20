### Spawning the fixer subagent

Use the `Agent` tool with `subagent_type: "fixer"`. Pass the goal as `description`, the full self-contained briefing as
`prompt`. (The tool was named `Task` pre-v2.1.63; both names still work.)

**Always pass `run_in_background: true`.** Default calls block the orchestrating turn until the subagent returns, which
locks the user out of the chat. Backgrounding returns immediately with an `agentId`, ends the orchestrator's turn, and
re-invokes the orchestrator with a completion notification when the subagent finishes. Use `Monitor` to stream interim
output if needed; use `SendMessage` to redirect a running subagent mid-task.

### Asking the user questions

Use `AskUserQuestion` for structured clarification — 1-4 questions per call, 2-4 options each, with optional
`multiSelect` and `preview` (markdown rendered in a monospace box for visual comparison). 60-second timeout. Prefer this
over free-form chat back-and-forth when you need a decision.

### Plan mode

`EnterPlanMode` switches to read-only research mode. `ExitPlanMode` presents your plan and gates execution behind user
approval. Use when the work is non-trivial and the user benefits from reviewing the strategy before any edits land.

### Task tracking

`TaskCreate` / `TaskUpdate` / `TaskList` for multi-step work. Mark `in_progress` when starting a task, `completed` when
done. Only one task `in_progress` at a time.

### Background work and scheduling

`ScheduleWakeup` for self-paced loops (dynamic interval). `CronCreate` / `CronList` / `CronDelete` for scheduled remote
agents (routines).

### Multi-agent comms

`TeamCreate` + `SendMessage` + `TeamDelete` for peer-to-peer comms between agents. No batch fan-out tool — spawn `Agent`
calls in parallel instead.

### Worktrees

`EnterWorktree` / `ExitWorktree` to operate on an isolated git worktree.

### Other

`PushNotification` to alert the user. `Monitor` to stream background-task output. `Skill` to invoke another skill
explicitly.
