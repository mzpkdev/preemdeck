# Claude Code ↔ Codex CLI ↔ Gemini CLI

Cross-host cheat sheet for plugin/skill authoring. Verified against Claude Code, Codex, and Gemini CLI docs, 2026-05-21.

---

## Same

The skeleton ports. One file, all three hosts.

| Concept             | Shape across all three                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `SKILL.md` basics   | Markdown body + YAML frontmatter with `name`, `description`                                                                                |
| MCP servers         | `mcpServers` JSON shape in settings or extension manifest                                                                                  |
| Hook config nesting | `event → matcher → handlers` — JSON on Claude/Gemini; JSON or inline TOML on Codex                                                         |
| Hook IO             | JSON on stdin / stdout, exit `0` success / `2` block                                                                                       |
| Hook `command` type | Executes on all three                                                                                                                      |
| Skill auto-invoke   | Description-string matching — front-load triggers and exclusions                                                                           |
| `AGENTS.md`         | Native on Codex; Claude reads `CLAUDE.md` (transclude via `` !`cat AGENTS.md` ``); Gemini reads it if you set `contextFileName: AGENTS.md` |

### Path map

```text
plugin / extension manifest
  Claude  → .claude-plugin/plugin.json
  Codex   → .codex-plugin/plugin.json
  Gemini  → gemini-extension.json   (at extension root)

marketplace catalog   (at marketplace root — Gemini has no equivalent)
  Claude  → .claude-plugin/marketplace.json
  Codex   → .agents/plugins/marketplace.json   (also reads .claude-plugin/marketplace.json as compat)
  Gemini  → —   (install per-extension: `gemini extensions install --path <dir>`)

skills directory
  Claude  → ~/.claude/skills/   .claude/skills/   <plugin>/skills/
  Codex   → $HOME/.agents/skills/   .agents/skills/   <plugin>/skills/
  Gemini  → ~/.agents/skills/   .agents/skills/   ~/.gemini/skills/   .gemini/skills/   <plugin>/skills/
            (within each tier, .agents/skills/ wins over .gemini/skills/)

subagents directory
  Claude  → ~/.claude/agents/*.md        .claude/agents/*.md       <plugin>/agents/*.md
  Codex   → ~/.codex/agents/*.toml       .codex/agents/*.toml      (no plugin tier — Codex plugins can't bundle subagents)
  Gemini  → ~/.gemini/agents/*.md        .gemini/agents/*.md       <plugin>/agents/*.md

context file (default)
  Claude  → CLAUDE.md   (does NOT natively read AGENTS.md — open feature request; transclude with `` !`cat AGENTS.md` `` inside CLAUDE.md)
  Codex   → AGENTS.md
  Gemini  → GEMINI.md   (override via gemini-extension.json `contextFileName`)

settings file   (JSON for Claude/Gemini, TOML for Codex; all three layer project over user)
  Claude  → ~/.claude/settings.json   .claude/settings.json   .claude/settings.local.json
  Codex   → ~/.codex/config.toml      .codex/config.toml   (project layer requires trust — see Gotchas)
  Gemini  → ~/.gemini/settings.json   .gemini/settings.json
```

---

## Different

No parity. Pick one path, or ship three.

| Feature                      | Claude Code                                                                                                                                                             | Codex                                                                                                                                                                                                                                                                                                     | Gemini CLI                                                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Settings format              | `settings.json` (JSON)                                                                                                                                                  | `config.toml` (TOML) + admin `requirements.toml`                                                                                                                                                                                                                                                          | `settings.json` (JSON)                                                                                                                                       |
| Plugin / extension manifest  | `.claude-plugin/plugin.json`                                                                                                                                            | `.codex-plugin/plugin.json`                                                                                                                                                                                                                                                                               | `gemini-extension.json`                                                                                                                                      |
| Marketplace catalog          | `.claude-plugin/marketplace.json` (schema: `name`/`description`/`owner`/`plugins[]`)                                                                                    | `.agents/plugins/marketplace.json` native; also reads `.claude-plugin/marketplace.json` as compat (schema: `name`/`interface.displayName`/`plugins[].source`/`policy`/`category`)                                                                                                                         | None — `gemini extensions install` runs one extension at a time                                                                                              |
| Custom commands              | Markdown                                                                                                                                                                | Markdown (slash commands; separate `~/.codex/prompts/*.md` "custom prompts" surface is deprecated → use skills)                                                                                                                                                                                           | **TOML** at `commands/<name>.toml`                                                                                                                           |
| Subagent file format         | Markdown + YAML (`agents/*.md`)                                                                                                                                         | TOML (`developer_instructions = "..."`)                                                                                                                                                                                                                                                                   | Markdown + YAML (`.gemini/agents/*.md`)                                                                                                                      |
| Subagent invocation          | `Agent` tool (alias `Task`; renamed v2.1.63) — `subagent_type` + `description` + `prompt`                                                                               | `spawn_agent({agent, instruction, fork_turns})` ([docs](https://developers.openai.com/codex/subagents)); community also reports `agent_type`/`model`/`reasoning_effort`/`task_name`/`message` overrides ([#20077](https://github.com/openai/codex/issues/20077)). Batch fan-out via `spawn_agents_on_csv` | Subagent's own name becomes a tool the main agent calls; `@name` in a user prompt nudges main to pick that tool                                              |
| Multi-agent comms            | `Agent`, `TeamCreate`, `SendMessage`, `TeamDelete`                                                                                                                      | Built-in subagents (`default`/`worker`/`explorer`) + user/project `.toml` files; batch fan-out via `spawn_agents_on_csv` + `report_agent_job_result`; `/agent` switches threads; enabled by default                                                                                                       | Subagents exposed as tools to the main agent only — no peer-to-peer                                                                                          |
| Subagent recursion           | Allowed                                                                                                                                                                 | Allowed; `[agents] max_depth = 1` default (root depth 0, one child level)                                                                                                                                                                                                                                 | **Blocked** — runtime hides agent tools from subagents, even with `tools: ["*"]`                                                                             |
| Batch spawning               | —                                                                                                                                                                       | `spawn_agents_on_csv` (paired with `report_agent_job_result`)                                                                                                                                                                                                                                             | —                                                                                                                                                            |
| Built-in subagent catalog    | (none — define your own)                                                                                                                                                | `default`, `worker`, `explorer`                                                                                                                                                                                                                                                                           | `generalist`, `cli_help`, `codebase_investigator`                                                                                                            |
| Ask-user tool (LLM-callable) | `AskUserQuestion` — 1-4 Q per call, 2-4 opts each, `multiSelect`, `preview` (markdown box); 60s timeout. v2.0.21+                                                       | `ask_user_question` — single/multi-choice options with optional custom-answer slot per question                                                                                                                                                                                                           | `ask_user` (v0.29.0+) — 1-4 Q; types `choice` / `text` / `yesno`; `header` ≤16ch; `multiSelect` auto-adds "All the above"                                    |
| Plan mode                    | **LLM-callable**: `EnterPlanMode` / `ExitPlanMode` tools — the agent can enter and exit programmatically                                                                | **User-toggled only** — no LLM-callable plan-mode tool. Mode set via host UI (`/plan` slash command or `Shift+Tab`); the LLM operates within whatever mode the user picked                                                                                                                                | **User-toggled only** — same shape as Codex; no LLM-callable entry. Plan mode is read-only filesystem with markdown writes restricted to the plans directory |
| Task tracking (LLM-callable) | `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet` / `TaskOutput` / `TaskStop` — statuses `pending` / `in_progress` / `completed`                                     | `update_plan` — array of `{step, status}`; statuses `pending` / `in_progress` / `done`                                                                                                                                                                                                                    | `write_todos` — array of `{description, status}`; statuses `pending` / `in_progress` / `completed` / `cancelled` / `blocked`                                 |
| Cross-session memory tool    | —                                                                                                                                                                       | —                                                                                                                                                                                                                                                                                                         | `save_memory`                                                                                                                                                |
| Scheduling                   | `ScheduleWakeup` (loop pacing) + `CronCreate`/`CronList`/`CronDelete` (routines)                                                                                        | —                                                                                                                                                                                                                                                                                                         | —                                                                                                                                                            |
| LSP integration              | Plugin manifest `lspServers`                                                                                                                                            | None (open feature request)                                                                                                                                                                                                                                                                               | None                                                                                                                                                         |
| Effort levels                | `low` / `medium` / `high` / `xhigh` / `max` (`xhigh`/`max` Opus 4.7+; `xhigh` is the Opus 4.7 default since v2.1.117; `max` is session-only, not persisted in settings) | —                                                                                                                                                                                                                                                                                                         | —                                                                                                                                                            |
| Status line / TUI patching   | `statusLine`, `tweakcc`                                                                                                                                                 | —                                                                                                                                                                                                                                                                                                         | —                                                                                                                                                            |
| IDE bridge                   | JetBrains ACP                                                                                                                                                           | —                                                                                                                                                                                                                                                                                                         | Google IDE integrations                                                                                                                                      |
| Skill-to-skill               | `Skill` tool                                                                                                                                                            | —                                                                                                                                                                                                                                                                                                         | —                                                                                                                                                            |
| Worktrees                    | `isolation: "worktree"` + hooks                                                                                                                                         | —                                                                                                                                                                                                                                                                                                         | —                                                                                                                                                            |
| Auto-activation by file path | `paths:` frontmatter                                                                                                                                                    | —                                                                                                                                                                                                                                                                                                         | —                                                                                                                                                            |
| Themes in extensions         | —                                                                                                                                                                       | —                                                                                                                                                                                                                                                                                                         | Yes                                                                                                                                                          |
| Tool restriction unit        | Per-skill (`allowed-tools`)                                                                                                                                             | Per-agent (`sandbox_mode`, frontmatter `tools` allowlist)                                                                                                                                                                                                                                                 | Per-extension (`excludeTools`) + per-agent (frontmatter `tools` allowlist)                                                                                   |
| Per-subagent policy gate     | Permissions are session-wide — see `claude --agent <name>` for whole-session scoping                                                                                    | Per-agent `.toml` only — no main-side enforcement surface                                                                                                                                                                                                                                                 | `policy.toml` `[[rules]] subagent = "name"` — only documented surface that sees subagent identity at runtime                                                 |
| `auto` permission mode       | Yes                                                                                                                                                                     | —                                                                                                                                                                                                                                                                                                         | (own model — not directly mapped)                                                                                                                            |
| Command conflict resolution  | Manual                                                                                                                                                                  | Manual                                                                                                                                                                                                                                                                                                    | Auto-prefix — `/<extension>.<command>`                                                                                                                       |

### Hook events

| Semantic role             | Claude                | Codex               | Gemini                |
| ------------------------- | --------------------- | ------------------- | --------------------- |
| Session begins            | `SessionStart`        | `SessionStart`      | `SessionStart`        |
| Session ends              | `SessionEnd`          | —                   | `SessionEnd`          |
| Setup / init              | `Setup`               | —                   | —                     |
| User prompt submitted     | `UserPromptSubmit`    | `UserPromptSubmit`  | `BeforeAgent`         |
| Slash command expansion   | `UserPromptExpansion` | —                   | —                     |
| Turn ends (agent done)    | `Stop`                | `Stop`              | `AfterAgent`          |
| Turn ends with error      | `StopFailure`         | —                   | —                     |
| Before LLM call           | —                     | —                   | `BeforeModel`         |
| Before tool selection     | —                     | —                   | `BeforeToolSelection` |
| After LLM call            | —                     | —                   | `AfterModel`          |
| Before tool call          | `PreToolUse`          | `PreToolUse`        | `BeforeTool`          |
| After tool succeeds       | `PostToolUse`         | `PostToolUse`       | `AfterTool`           |
| After tool fails          | `PostToolUseFailure`  | —                   | —                     |
| After parallel batch      | `PostToolBatch`       | —                   | —                     |
| Permission requested      | `PermissionRequest`   | `PermissionRequest` | —                     |
| Permission auto-denied    | `PermissionDenied`    | —                   | —                     |
| Notification fired        | `Notification`        | —                   | `Notification`        |
| Before context compaction | `PreCompact`          | —                   | `PreCompress`         |
| After context compaction  | `PostCompact`         | —                   | —                     |
| MCP elicitation           | `Elicitation`         | —                   | —                     |
| MCP elicitation result    | `ElicitationResult`   | —                   | —                     |
| Cwd changes               | `CwdChanged`          | —                   | —                     |
| File changes              | `FileChanged`         | —                   | —                     |
| Config changes            | `ConfigChange`        | —                   | —                     |
| Instructions loaded       | `InstructionsLoaded`  | —                   | —                     |
| Subagent spawned          | `SubagentStart`       | —                   | —                     |
| Subagent finishes         | `SubagentStop`        | —                   | —                     |
| Teammate idle             | `TeammateIdle`        | —                   | —                     |
| Task created              | `TaskCreated`         | —                   | —                     |
| Task completed            | `TaskCompleted`       | —                   | —                     |
| Worktree created          | `WorktreeCreate`      | —                   | —                     |
| Worktree removed          | `WorktreeRemove`      | —                   | —                     |

### Hook handler types

| Type          | Claude | Codex         | Gemini      |
| ------------- | ------ | ------------- | ----------- |
| `command`     | runs   | runs          | runs        |
| `http`        | runs   | parses, skips | not in spec |
| `prompt`      | runs   | parses, skips | not in spec |
| `agent`       | runs   | parses, skips | not in spec |
| `mcp_tool`    | runs   | —             | —           |
| `async: true` | runs   | parses, skips | not in spec |

### Hook output fields

| Field                          | Claude                                   | Codex                                      | Gemini                                            |
| ------------------------------ | ---------------------------------------- | ------------------------------------------ | ------------------------------------------------- |
| `continue`, `stopReason`       | yes                                      | yes                                        | yes                                               |
| `systemMessage`                | yes                                      | yes                                        | yes                                               |
| `suppressOutput`               | yes                                      | yes                                        | yes                                               |
| `decision` + `reason`          | `"block"`                                | `"block"`                                  | `"allow"` / `"deny"` / `"block"`                  |
| `hookSpecificOutput`           | yes                                      | yes                                        | yes                                               |
| `additionalContext`            | inside `hookSpecificOutput`              | inside `hookSpecificOutput`                | inside `hookSpecificOutput`                       |
| `updatedInput` (PreToolUse)    | inside `hookSpecificOutput.updatedInput` | top-level                                  | inside `hookSpecificOutput.tool_input`            |
| `permissionDecision`           | `allow`/`deny`/`ask`/`defer`             | `allow`/`deny` (`ask` parsed, unsupported) | —                                                 |
| `permissionDecisionReason`     | yes                                      | —                                          | —                                                 |
| `terminalSequence`             | yes                                      | —                                          | —                                                 |
| `retry` (PermissionDenied)     | yes                                      | —                                          | —                                                 |
| `tailToolCallRequest`          | —                                        | —                                          | inside `hookSpecificOutput` (AfterTool)           |
| `toolConfig`                   | —                                        | —                                          | inside `hookSpecificOutput` (BeforeToolSelection) |
| `clearContext`                 | —                                        | —                                          | inside `hookSpecificOutput` (AfterAgent)          |
| `llm_request` / `llm_response` | —                                        | —                                          | inside `hookSpecificOutput` (model hooks)         |

### `SKILL.md` frontmatter

| Field                      | Claude | Codex                          | Gemini |
| -------------------------- | ------ | ------------------------------ | ------ |
| `name`                     | yes    | yes                            | yes    |
| `description`              | yes    | yes                            | yes    |
| `when_to_use`              | yes    | —                              | —      |
| `disable-model-invocation` | yes    | (sibling `agents/openai.yaml`) | —      |
| `user-invocable`           | yes    | —                              | —      |
| `allowed-tools`            | yes    | —                              | —      |
| `model`                    | yes    | —                              | —      |
| `effort`                   | yes    | —                              | —      |
| `context`                  | yes    | —                              | —      |
| `agent`                    | yes    | —                              | —      |
| `argument-hint`            | yes    | —                              | —      |
| `arguments`                | yes    | —                              | —      |
| `paths`                    | yes    | —                              | —      |
| `shell`                    | yes    | —                              | —      |
| `hooks`                    | yes    | —                              | —      |

### Placeholders and variables

| Variable                 | Claude | Codex                   | Gemini                         |
| ------------------------ | ------ | ----------------------- | ------------------------------ |
| `$ARGUMENTS`, `$N`       | yes    | —                       | —                              |
| `$ARGUMENTS[N]`, `$name` | yes    | —                       | —                              |
| `${CLAUDE_SKILL_DIR}`    | yes    | —                       | —                              |
| `${CLAUDE_SESSION_ID}`   | yes    | —                       | (use `GEMINI_SESSION_ID`)      |
| `${CLAUDE_EFFORT}`       | yes    | —                       | —                              |
| `${CLAUDE_PLUGIN_ROOT}`  | yes    | alias for `PLUGIN_ROOT` | —                              |
| `${CLAUDE_PLUGIN_DATA}`  | yes    | alias for `PLUGIN_DATA` | —                              |
| `${CLAUDE_PROJECT_DIR}`  | yes    | —                       | alias for `GEMINI_PROJECT_DIR` |
| `${GEMINI_PROJECT_DIR}`  | —      | —                       | yes                            |
| `${GEMINI_PLANS_DIR}`    | —      | —                       | yes                            |
| `${GEMINI_SESSION_ID}`   | —      | —                       | yes                            |
| `${GEMINI_CWD}`          | —      | —                       | yes                            |
| `${extensionPath}`       | —      | —                       | yes (manifest + hook config)   |

Two systems, one syntax. On Gemini, **`${extensionPath}`**, **`${workspacePath}`**, and **`${/}`** are _manifest
placeholders_ substituted by the host before launching the process; the `GEMINI_*` names are _env vars_ exposed to the
spawned process, so `${GEMINI_PROJECT_DIR}` only resolves via shell expansion inside hook `command` strings — it isn't
substituted in `gemini-extension.json` fields the host parses directly.

### Settings

```jsonc
// Claude — ~/.claude/settings.json
{
  "permissions":  { "allow": [...], "deny": [...], "defaultMode": "acceptEdits" },
  "statusLine":   { "type": "command", "command": "..." },
  "env":          { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1", "CLAUDE_CODE_EFFORT_LEVEL": "max" },
  "effortLevel":  "xhigh"
}
```

```toml
# Codex — ~/.codex/config.toml  (or project-local .codex/config.toml)
[permissions]
default_mode = "acceptEdits"

[agents]
max_threads             = 6
max_depth               = 1
job_max_runtime_seconds = 1800

[features]
plugin_hooks = true

# Hooks — inline TOML form; equivalent JSON in .codex/hooks.json also works
[[hooks.PostToolUse]]
matcher = "(apply_patch|Edit|Write)"

[[hooks.PostToolUse.hooks]]
type    = "command"
command = '"$HOME/.preemdeck/scripts/preemdeck-bun" "$(git rev-parse --show-toplevel)/scripts/format-on-edit.ts"'
timeout = 30
```

```jsonc
// Gemini — ~/.gemini/settings.json
{
  "mcpServers": {
    "github": { "command": "docker", "args": [...] }
  },
  "hooks": {
    "BeforeTool": [{ "matcher": "write_.*", "hooks": [...] }]
  },
  "mcp": { "allowed": [...], "excluded": [...] }
}
```

### Subagents

```yaml
# Claude — agents/reviewer.md
---
name: reviewer
description: Adversarial security pass
model: opus
---
You are a security reviewer...
```

```toml
# Codex — ~/.codex/agents/reviewer.toml
name                   = "reviewer"
description            = "Adversarial security pass"
model                  = "gpt-5.3-codex"
sandbox_mode           = "read-only"
developer_instructions = """
You are a security reviewer...
"""
```

```yaml
# Gemini — .gemini/agents/reviewer.md
---
name: reviewer
description: Adversarial security pass
kind: local # 'local' (default) | 'remote'  — added 2026
model: gemini-2.5-pro
tools: [read_file, grep_search]
mcpServers: {} # inline per-agent MCP config — added 2026
temperature: 0.2 # 0.0–2.0, default 1
max_turns: 10 # default 30
timeout_mins: 5 # default 10
---
You are a security reviewer...
```

---

## Gotchas

Looks the same. Isn't.

| Trap                                                                       | Why it bites                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Fix                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hook event renames on Gemini                                               | `PreToolUse` ≠ `BeforeTool` — string-level mismatch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Treat events as semantic roles; remap names per host                                                                                                                                                                                                                                                                |
| Hook `type: prompt` / `agent`                                              | Parses but skips on Codex; not in spec on Gemini                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Use `type: command` only for portability                                                                                                                                                                                                                                                                            |
| Hook `async: true`                                                         | Parses on Codex; not in Gemini spec                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Don't depend on non-blocking behavior                                                                                                                                                                                                                                                                               |
| Skill-scoped `hooks:` in `SKILL.md`                                        | Claude-only frontmatter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Promote to manifest-level `hooks` block                                                                                                                                                                                                                                                                             |
| `allowed-tools:` in `SKILL.md`                                             | Claude-only per-skill restriction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Codex: `sandbox_mode`. Gemini: `excludeTools` on extension manifest                                                                                                                                                                                                                                                 |
| `disable-model-invocation: true`                                           | Claude frontmatter; Codex uses a separate file; Gemini relies on description text                                                                                                                                                                                                                                                                                                                                                                                                                                                                | See side-by-side below                                                                                                                                                                                                                                                                                              |
| Preload `` !`cmd` `` or fenced ` ```! `                                    | Claude-only sugar — silent no-op elsewhere                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Move into a runtime body step                                                                                                                                                                                                                                                                                       |
| `argument-hint`, per-skill `model:`                                        | Not documented for Codex or Gemini SKILL.md                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Drop or duplicate as prose                                                                                                                                                                                                                                                                                          |
| Tool-name matchers `Edit` / `Write`                                        | Codex aliases to `apply_patch`; Gemini uses `write_file` and `replace` (`edit` is just `replace`'s display name, not a tool name)                                                                                                                                                                                                                                                                                                                                                                                                                | Per-host regex: `(Edit\|Write\|MultiEdit)` · `(apply_patch\|Edit\|Write)` · `(write_.*\|replace)`                                                                                                                                                                                                                   |
| Codex `tool_name` is always `apply_patch`                                  | Matcher accepts `Edit` / `Write` as aliases, but the stdin payload's `tool_name` field is _always_ `apply_patch` — a script that branches on `tool_name == "Edit"` never matches                                                                                                                                                                                                                                                                                                                                                                 | Branch on `apply_patch`, or look at `tool_input.file_path` instead                                                                                                                                                                                                                                                  |
| Claude matcher mode flip                                                   | Only `[A-Za-z0-9_\|]` → exact-string list. Any other char (`.`, `*`, `^`, `(`, …) flips to JS RegExp — `"mcp__memory"` matches only the literal tool; `"mcp__memory.*"` matches the family                                                                                                                                                                                                                                                                                                                                                       | Use `tool\|tool` for exact lists; anchored regex (`^foo`, `foo.*`) otherwise — and test it                                                                                                                                                                                                                          |
| Exit `2` is not universally blocking                                       | On Claude, `PostToolUse` / `PermissionDenied` / `Notification` / `SessionEnd` cannot block (the action already happened); `WorktreeCreate` treats _any_ non-zero exit as failure                                                                                                                                                                                                                                                                                                                                                                 | Block at the pre-event when possible; for post-events, exit 2 stops the _next_ turn, not the side effect                                                                                                                                                                                                            |
| `permission_mode: auto`                                                    | Claude only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Treat `auto` as `default` elsewhere                                                                                                                                                                                                                                                                                 |
| Context file name                                                          | Defaults differ: `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | On Gemini set `contextFileName: AGENTS.md` for one source of truth                                                                                                                                                                                                                                                  |
| Subagent recursion                                                         | Allowed on Claude/Codex, **blocked** on Gemini                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Don't chain subagents from inside subagents on Gemini                                                                                                                                                                                                                                                               |
| `@name` subagent invocation                                                | Gemini-only syntax                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | A skill that "spawns worker" needs a per-host variant                                                                                                                                                                                                                                                               |
| Custom command file format                                                 | Markdown on Claude/Codex; **TOML** on Gemini                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Maintain two files, or skip custom commands and use skills                                                                                                                                                                                                                                                          |
| Codex plugins can't bundle subagents                                       | Official plugin components are skills / `.mcp.json` / `.app.json` / hooks / assets only — `agents` is not a manifest field. A `<plugin>/agents/*.toml` (or `<plugin>/.codex/agents/*.toml`) sits there ignored                                                                                                                                                                                                                                                                                                                                   | Ship the `.toml` in the plugin's `assets/` + copy to `~/.codex/agents/` via `SessionStart` hook, or document the manual copy in the plugin README                                                                                                                                                                   |
| MCP-tool hook matching on Codex                                            | Shipped April 2026; older versions match only Bash + `apply_patch`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Pin a minimum Codex version                                                                                                                                                                                                                                                                                         |
| Codex project `.codex/` skipped until trusted                              | First run prompts; if declined, `.codex/config.toml` (hooks, agents, rules) silently doesn't load                                                                                                                                                                                                                                                                                                                                                                                                                                                | Accept the trust prompt, or pre-add `[projects."/abs/path"] trust_level = "trusted"` to `~/.codex/config.toml`                                                                                                                                                                                                      |
| No project-root env var on Codex                                           | Claude exposes `${CLAUDE_PROJECT_DIR}` and Gemini exposes `${GEMINI_PROJECT_DIR}` — Codex exposes neither                                                                                                                                                                                                                                                                                                                                                                                                                                        | In a Codex hook `command`, compute the root via `$(git rev-parse --show-toplevel)` or use an absolute path                                                                                                                                                                                                          |
| Extension command auto-prefix                                              | Gemini namespaces conflicts as `/<ext>.<cmd>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Don't assume a flat slash command space                                                                                                                                                                                                                                                                             |
| `ultrathink` keyword                                                       | Triggers deep reasoning on Claude only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Don't rely on it elsewhere                                                                                                                                                                                                                                                                                          |
| `excludeTools`                                                             | Gemini-only — restricts tools at extension level                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Use per-skill / per-agent mechanisms on Claude / Codex                                                                                                                                                                                                                                                              |
| Env var aliasing                                                           | `CLAUDE_PLUGIN_ROOT` aliased on Codex only; `CLAUDE_PROJECT_DIR` aliased on Gemini only                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Branch by host or pass paths into prompts                                                                                                                                                                                                                                                                           |
| Skill discovery path                                                       | `.claude/skills/` vs `.agents/skills/` vs `.gemini/skills/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Gemini ranks `.agents/skills/` **above** `.gemini/skills/` in the same tier — `.agents/skills/` is the cross-host shared path on Codex + Gemini                                                                                                                                                                     |
| Hooks can't tell main from subagent                                        | All three hosts: PreToolUse/BeforeTool payloads omit a parent/child discriminator. Claude docs claim `agent_id`/`agent_type` on PreToolUse during subagent calls, but community reports them empirically absent for shell-command hooks ([#54898](https://github.com/anthropics/claude-code/issues/54898), [#40140](https://github.com/anthropics/claude-code/issues/40140)). Codex subagent hooks share the parent's `session_id` (per [changelog #22268](https://developers.openai.com/codex/changelog)). Gemini's BeforeTool exposes nothing. | Don't try to deny "main only" tool calls via PreToolUse — the same hook fires for the subagent and you'll deny both. Use the per-agent surfaces below                                                                                                                                                               |
| Per-subagent enforcement is NOT hook-based                                 | Claude: start the whole session as a restricted subagent — `claude --agent <name>` ([Subagents → "Run the whole session as a subagent"](https://code.claude.com/docs/en/sub-agents)). Codex: the agent's own `.toml` (`sandbox_mode`, `tools`); no main-side gate documented. Gemini: Policy Engine `policy.toml` `[[rules]] subagent = "name"` — the only documented surface that sees subagent identity.                                                                                                                                       | Pick the host's per-agent surface; treat hooks as global rules only                                                                                                                                                                                                                                                 |
| Codex `spawn_agent` schema double-surface                                  | Official schema is `{agent, instruction, fork_turns}` ([subagents docs](https://developers.openai.com/codex/subagents)). Community reports the tool also accepts `agent_type` / `model` / `reasoning_effort` / `task_name` / `message` ([#20077](https://github.com/openai/codex/issues/20077)). Default `fork_turns: true` inherits full history and rejects type/model/effort overrides.                                                                                                                                                       | For simple delegation use `{agent, instruction}`. For overrides set `fork_turns: false`. Teach the model the call shape in instructional content (SessionStart imprints, skill bodies, subagent prompts) — the model still emits the actual call. Don't programmatically construct `spawn_agent` from your own code |
| Claude `Agent` tool was `Task`                                             | Renamed in v2.1.63. `Task(...)` still works as alias; new docs and code use `Agent`                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Search for both names when scanning older repos, blog posts, or community plugins                                                                                                                                                                                                                                   |
| Plain stdout on `SessionStart` — Claude+Codex inject it, Gemini forbids it | Claude and Codex both document non-JSON stdout from `SessionStart` as auto-injected `additionalContext` ([Claude hooks reference](https://code.claude.com/docs/en/hooks), [Codex hooks docs](https://developers.openai.com/codex/hooks)). Gemini's reference: _"Your script must not print any plain text to stdout other than the final JSON."_ Gemini's `additionalContext` injection only works after PR [#15746](https://github.com/google-gemini/gemini-cli/pull/15746) (merged 2026-01-05) — older builds drop it silently.                | Cross-host hooks emit the envelope `hookSpecificOutput.{hookEventName, additionalContext}` — works on all three. Reach for `cat file.md`-style plain stdout only if you're Claude+Codex-only.                                                                                                                       |

### Side-by-side

```jsonc
// hook event rename — same matcher, different name
// Claude / Codex
{ "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [...] }] } }
```

```jsonc
// Gemini
{ "hooks": { "BeforeTool": [{ "matcher": "Bash", "hooks": [...] }] } }
```

```yaml
# disable-model-invocation
# Claude — SKILL.md frontmatter
disable-model-invocation: true
```

```yaml
# Codex — skills/<skill>/agents/openai.yaml
policy:
  allow_implicit_invocation: false
```

```yaml
# Gemini — no toggle; use a specific description
description: "Manual deploy. NEVER trigger automatically; only when user types /deploy."
```

```markdown
# custom command — Markdown on Claude/Codex

# .claude/commands/deploy.md

---

## description: Deploy to staging

Push the current branch and trigger the deploy pipeline.
```

```toml
# Gemini — TOML at commands/deploy.toml
description = "Deploy to staging"
prompt = """
Push the current branch and trigger the deploy pipeline.
"""
```

```markdown
# preload — Claude-only sugar

# Claude — SKILL.md body

## Preload

!`"$HOME/.preemdeck/scripts/preemdeck-bun" ${CLAUDE_PLUGIN_ROOT}/scripts/gather.ts`
```

```markdown
# Codex — runtime step (CLAUDE_PLUGIN_ROOT aliased to PLUGIN_ROOT)

## Step 1 — Gather

Run `"$HOME/.preemdeck/scripts/preemdeck-bun" ${CLAUDE_PLUGIN_ROOT}/scripts/gather.ts` and parse the JSON.
```

```markdown
# Gemini — runtime step (no env var reaches the body; compute root in-script)

## Step 1 — Gather

Run `"$HOME/.preemdeck/scripts/preemdeck-bun" scripts/gather.ts` — the script self-locates via
`dirname(fileURLToPath(import.meta.url))`. Parse the JSON output.
```

---

## Quick checklist

```
Cross-host    ── SKILL.md basics, mcpServers, hook JSON shape, exit 0/2, `command` hook type, AGENTS.md (with override on Gemini)
Hook names    ── Claude/Codex use Pre/Post; Gemini uses Before/After — adapter must remap by semantic role
Hook types    ── only `command` is universal; prompt / agent / async are Claude-only execute
Event scope   ── Claude has the largest catalog; Gemini uniquely adds model-layer hooks
Output fields ── hookSpecificOutput wraps `additionalContext` on all three; `decision`/`reason` stay top-level on Codex+Gemini; `permissionDecision` is Claude-only and narrows host-by-host
Subagents     ── 3 formats — Claude md at agents/, Codex TOML at .codex/agents/, Gemini md at .gemini/agents/
Multi-agent   ── Claude has SendMessage/Team; Codex has built-in subagents (default/worker/explorer) + spawn_agents_on_csv batch (enabled by default); Gemini main-agent-to-subagent only, no peer-to-peer
Recursion     ── blocked on Gemini (runtime-hidden); allowed elsewhere — Codex caps at `[agents] max_depth = 1` by default
Per-subagent  ── enforcement NOT hook-based — Claude `claude --agent <name>`, Codex per-agent `.toml` sandbox/tools, Gemini Policy Engine `[[rules]] subagent = "..."`
Settings      ── Claude/Gemini JSON; Codex TOML; all 3 layer project over user (Codex needs trust)
Manifests     ── .claude-plugin/plugin.json · .codex-plugin/plugin.json · gemini-extension.json
Context file  ── CLAUDE.md / AGENTS.md / GEMINI.md — set contextFileName on Gemini for cross-host AGENTS.md
Commands      ── Markdown (Claude/Codex) vs TOML (Gemini)
Frontmatter   ── only name + description are universal — everything else is host-specific
Placeholders  ── $ARGUMENTS, $N, $name, ${CLAUDE_SKILL_DIR} are Claude only
Env vars      ── ${CLAUDE_PLUGIN_ROOT} aliased on Codex; ${CLAUDE_PROJECT_DIR} aliased on Gemini; no var works everywhere
Invocation    ── Claude `Agent` tool (was `Task` pre-v2.1.63) · Codex `spawn_agent({agent, instruction, fork_turns})` + `spawn_agents_on_csv` batch · Gemini: subagent's own name IS the tool, `@name` user-prefix is a hint
Ask user      ── Claude `AskUserQuestion` (1-4 Q, choice + multiSelect + preview) · Codex `ask_user_question` (single/multi-choice + custom answer) · Gemini `ask_user` (choice/text/yesno) — all three ship LLM-callable structured Q&A
Plan mode     ── Claude has LLM-callable `EnterPlanMode`/`ExitPlanMode` tools · Codex + Gemini have user-toggled plan mode only — the LLM has no entry tool, it operates within whatever mode the user set
Task track    ── Claude `TaskCreate`/`TaskUpdate` · Codex `update_plan` · Gemini `write_todos` — statuses overlap on `pending`/`in_progress`; Gemini adds `cancelled`/`blocked`; Codex uses `done` not `completed`
Built-in subs ── Claude (none — bring your own) · Codex `default`/`worker`/`explorer` · Gemini `generalist`/`cli_help`/`codebase_investigator`
Scheduling    ── Claude only — `ScheduleWakeup` + `CronCreate`/`Delete`/`List`
Cross-session ── Gemini only — `save_memory` tool; Claude/Codex use AGENTS.md / project files
Tool restrict ── per-skill (Claude), per-agent (Codex), per-extension (Gemini)
Skill paths   ── Codex .agents/skills/ · Gemini reads .agents/skills/ AND .gemini/skills/ (.agents/ wins in same tier) — .agents/ is shared with Codex
```
