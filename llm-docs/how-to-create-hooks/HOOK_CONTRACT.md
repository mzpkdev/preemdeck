# Hook contract

How hooks see and shape an agent's work, **shipped from inside a plugin** (not project-local wiring). Same
JSON-over-stdio contract on every host, but event names, payload nesting, and decision fields diverge. Cross-host
details in [CLAUDE_CODEX_GEMINI.md](../CLAUDE_CODEX_GEMINI.md).

---

## Where hooks plug in

A hook is a process the host spawns at a fixed moment in its loop. Same data flow on every host: JSON in, JSON out, exit
code decides.

```
host                  hook
  │                    │
  │── stdin: JSON ────▶│            ── event payload (tool name, input, cwd, session_id…)
  │                    │ work
  │◀── stdout: JSON ───│            ── decision + control fields (parsed only on exit 0)
  │◀── stderr ─────────│            ── logs / block reason (shown to user / model)
  │◀── exit code ──────│            ── 0 success · 2 block · other = warning
  │
  │  applies decision
  ▼
```

A hook _does not_ run inside the agent. It runs in a subprocess with the host's environment, the project's `cwd`, and a
host-provided timeout. Anything it learns must arrive on stdin; anything it changes must leave on stdout.

---

## Event catalog

Same semantic moments, different names. Pick by the role, then translate.

| Role                      | Claude                                   | Codex               | Gemini                |
| ------------------------- | ---------------------------------------- | ------------------- | --------------------- |
| Session begins            | `SessionStart`                           | `SessionStart`      | `SessionStart`        |
| Session ends              | `SessionEnd`                             | —                   | `SessionEnd`          |
| User submits a prompt     | `UserPromptSubmit`                       | `UserPromptSubmit`  | `BeforeAgent`         |
| Turn ends                 | `Stop` (+ `StopFailure`)                 | `Stop`              | `AfterAgent`          |
| Before LLM call           | —                                        | —                   | `BeforeModel`         |
| Before tool selection     | —                                        | —                   | `BeforeToolSelection` |
| Before a tool runs        | `PreToolUse`                             | `PreToolUse`        | `BeforeTool`          |
| After a tool runs         | `PostToolUse` (+ `PostToolUseFailure`)   | `PostToolUse`       | `AfterTool`           |
| Permission requested      | `PermissionRequest` / `PermissionDenied` | `PermissionRequest` | —                     |
| Notification fired        | `Notification`                           | —                   | `Notification`        |
| Before context compaction | `PreCompact` / `PostCompact`             | —                   | `PreCompress`         |
| Subagent lifecycle        | `SubagentStart` / `SubagentStop`         | —                   | —                     |
| File or cwd change        | `FileChanged` / `CwdChanged`             | —                   | —                     |
| Worktree lifecycle        | `WorktreeCreate` / `WorktreeRemove`      | —                   | —                     |

Treat an event as a _semantic role_, not a string — adapters remap by role. Claude's catalog is largest; Codex stays
small but load-bearing; Gemini uniquely sits between the LLM and tool selection.

---

## Matchers

The matcher filters which tool calls (or which lifecycle source) actually invokes the hook. Behavior diverges in a way
that silently misses calls.

| Host   | Default | Tool-event match target | Regex flavor          | Notes                                                           |
| ------ | ------- | ----------------------- | --------------------- | --------------------------------------------------------------- |
| Claude | none    | `tool_name`             | JS RegExp (ECMA 2020) | Letters/digits/`_`/`\|` only → exact-string list; else regex    |
| Codex  | none    | `tool_name`             | regex                 | Matcher accepts `Edit`/`Write` as aliases for `apply_patch`     |
| Gemini | none    | `tool_name`             | regex                 | Built-ins: `read_file`, `write_file`, `run_shell_command`, etc. |

```jsonc
// Claude — exact-string list (no regex chars)
{ "matcher": "Edit|Write|MultiEdit" }

// Claude — regex (presence of `.` flips on regex mode)
{ "matcher": "mcp__github__.*" }
```

Claude tool events additionally accept an `if` field using _permission-rule_ syntax — only spawns the hook when both the
matcher and the rule match. Use it to keep the matcher broad and the gate precise.

```jsonc
{
  "matcher": "Bash",
  "hooks": [{ "type": "command", "if": "Bash(rm *)", "command": "./block-rm.sh" }],
}
```

---

## Stdin payload

Common base fields land on every host. Event-specific fields land on the relevant events.

```json
// PreToolUse / BeforeTool — base + tool fields
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/path/to/project",
  "hook_event_name": "PreToolUse",

  "tool_name": "Write",
  "tool_input": {
    "file_path": "/path/to/file.ts",
    "content": "…"
  },
  "tool_use_id": "tool-use-123"
}
```

| Field             | Claude | Codex | Gemini | When                      |
| ----------------- | ------ | ----- | ------ | ------------------------- |
| `session_id`      | yes    | yes   | yes    | all events                |
| `transcript_path` | yes    | yes   | yes    | all events                |
| `cwd`             | yes    | yes   | yes    | all events                |
| `hook_event_name` | yes    | yes   | yes    | all events                |
| `tool_name`       | yes    | yes   | yes    | tool events               |
| `tool_input`      | yes    | yes   | yes    | tool events               |
| `tool_response`   | yes    | yes   | yes    | post-tool events          |
| `tool_use_id`     | yes    | yes   | —      | Claude/Codex tool events  |
| `permission_mode` | yes    | —     | —      | Claude tool/prompt events |
| `timestamp`       | —      | —     | yes    | Gemini, ISO 8601          |

Read stdin once, parse once. Don't assume optional fields exist — `tool_input.file_path` is `Write`-shaped on Claude but
absent on a `Bash` call.

---

## Stdout: decision payload

Exit `0` with valid JSON on stdout → the host parses it for control fields. Exit `0` with empty stdout → the action
proceeds unchanged (the most common case for advisory hooks like formatters).

Universal fields (parsed on all three hosts):

```json
{
  "continue": true,
  "stopReason": "human-readable reason if continue=false",
  "systemMessage": "warning shown to the user",
  "suppressOutput": false
}
```

Decision shape diverges. Same intent, different envelope per host and per event.

```jsonc
// Block at PreToolUse / BeforeTool
// Claude — permissionDecision inside hookSpecificOutput
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "rm -rf blocked by policy"
  }
}

// Codex — top-level decision + reason
{ "decision": "block", "reason": "rm -rf blocked by policy" }

// Gemini — top-level decision (allow/deny/block)
{ "decision": "deny", "reason": "rm -rf blocked by policy" }
```

```jsonc
// Block at PostToolUse / AfterTool — blocks the NEXT model call, not the just-run tool
// Claude / Codex / Gemini
{ "decision": "block", "reason": "tests failed — re-run before next step" }
```

| Decision lever         | Claude                                         | Codex                                  | Gemini                                   |
| ---------------------- | ---------------------------------------------- | -------------------------------------- | ---------------------------------------- |
| Block tool / next turn | `hookSpecificOutput.permissionDecision: deny`  | `decision: "block"`                    | `decision: "deny"` or `"block"`          |
| Allow with rule pin    | `hookSpecificOutput.permissionDecision: allow` | —                                      | `decision: "allow"`                      |
| Modify `tool_input`    | `hookSpecificOutput.updatedInput`              | `updatedInput`                         | `hookSpecificOutput.tool_input`          |
| Inject context         | `hookSpecificOutput.additionalContext`         | `hookSpecificOutput.additionalContext` | `hookSpecificOutput.additionalContext`   |
| Chain another tool     | —                                              | —                                      | `hookSpecificOutput.tailToolCallRequest` |
| Narrow tool set        | —                                              | —                                      | `hookSpecificOutput.toolConfig`          |
| Retry after denial     | `hookSpecificOutput.retry: true`               | —                                      | —                                        |

Wrap `additionalContext` in `hookSpecificOutput` on **all three** — Codex mirrors Claude's nested shape here despite
keeping most other fields (`decision`, `reason`, `updatedInput`) top-level. Smoke-test the JSON shape per host —
silently-dropped fields look like a working hook that does nothing.

For `SessionStart` specifically, Claude and Codex also accept plain (non-JSON) stdout — the host treats it as
`additionalContext` automatically. Gemini does not — its docs say _"Your script must not print any plain text to stdout
other than the final JSON."_ Cross-host hooks emit the envelope; reach for plain stdout only if you're
Claude+Codex-only.

---

## Exit code semantics

The exit code is the load-bearing signal. Stdout is parsed only when the code says success.

| Code  | Claude                                         | Codex                 | Gemini                   |
| ----- | ---------------------------------------------- | --------------------- | ------------------------ |
| `0`   | parse stdout JSON; otherwise proceed           | proceed; parse stdout | parse stdout (preferred) |
| `2`   | block; stderr fed back to the model / user     | block; stderr is why  | block; stderr is why     |
| other | non-blocking error; stderr shown in transcript | proceeds with warning | warning; CLI continues   |

Exit-2 behavior is event-shaped on Claude — most events block, but `PostToolUse`, `PermissionDenied`, `Notification`,
and `SessionEnd` cannot block (the action already happened). `WorktreeCreate` treats _any_ non-zero exit as failure.
Read the [Claude Code hooks reference][1] when adopting an exotic event.

---

## Hook handler types

Only `type: "command"` runs on all three hosts. Everything else parses silently on Codex or isn't in the Gemini spec at
all.

| Type          | Claude | Codex         | Gemini      |
| ------------- | ------ | ------------- | ----------- |
| `command`     | runs   | runs          | runs        |
| `http`        | runs   | parses, skips | not in spec |
| `prompt`      | runs   | parses, skips | not in spec |
| `agent`       | runs   | parses, skips | not in spec |
| `mcp_tool`    | runs   | —             | —           |
| `async: true` | runs   | parses, skips | not in spec |

A cross-host hook stays on `type: "command"`. Use `type: "http"` only in Claude-only plugins.

---

## Plugin layout

Each host reads hook config from the inline `hooks` block in its own native manifest. The script is shared — only the
wiring duplicates per host. No cross-host config coupling, no silently-failing entries when event names happen to
collide.

```
<plugin>/
├── .claude-plugin/plugin.json     ── Claude manifest + inline `hooks` block
├── .codex-plugin/plugin.json      ── Codex manifest + inline `hooks` block
├── gemini-extension.json          ── Gemini manifest + inline `hooks` block (at root, not in a subdir)
└── scripts/
    └── <name>-hook.ts            ── shared executable (run via the pinned preemdeck-runtime shim); one source of truth
```

The `-hook` suffix marks the file as a hook script (distinguishes it from skill helpers, install scripts, or other
`scripts/` contents). Each host reads only its own manifest's `hooks` block — Claude/Codex use `PreToolUse` /
`PostToolUse`, Gemini uses `BeforeTool` / `AfterTool`, so event-name differences sit naturally in separate files.

---

## Config shape — inline per manifest

The shared `<name>-hook.ts` lives at `<plugin>/scripts/<name>-hook.ts`. Each manifest carries its own `hooks` block
pointing at the same script through the pinned `preemdeck-runtime` shim.

```jsonc
// .claude-plugin/plugin.json — Claude
{
  "name": "...",
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "(Edit|Write|MultiEdit)",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/scripts/preemdeck-runtime\" \"${CLAUDE_PLUGIN_ROOT}/scripts/format-on-edit.ts\"",
            "timeout": 30,
          },
        ],
      },
    ],
  },
}
```

```jsonc
// .codex-plugin/plugin.json — Codex (aliases ${CLAUDE_PLUGIN_ROOT} → ${PLUGIN_ROOT})
{
  "name": "...",
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "(apply_patch|Edit|Write)", // Edit/Write are matcher aliases for apply_patch
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/scripts/preemdeck-runtime\" \"${CLAUDE_PLUGIN_ROOT}/scripts/format-on-edit.ts\"",
            "timeout": 30,
          },
        ],
      },
    ],
  },
}
```

```jsonc
// gemini-extension.json — Gemini
{
  "name": "...",
  "hooks": {
    "AfterTool": [
      {
        "matcher": "(write_.*|replace)", // Gemini's tool names (`edit` is `replace`'s display name)
        "hooks": [
          {
            "type": "command",
            "command": "\"${extensionPath}/scripts/preemdeck-runtime\" \"${extensionPath}/scripts/format-on-edit.ts\"",
            "timeout": 30,
          },
        ],
      },
    ],
  },
}
```

Codex aliases `${CLAUDE_PLUGIN_ROOT}` to its native `${PLUGIN_ROOT}`. Gemini recognizes neither — `${extensionPath}` is
its native placeholder. The script is the same file; each manifest holds its own wiring.

Three things port unchanged: the script, `type: "command"`, and `timeout`. Three things diverge: the event name
(Pre/Post vs Before/After), the matcher (because tool names differ), and the env-var placeholder for the plugin root —
each manifest holds its own copy, so the divergence stays clean.

---

## Plugin discovery and trust

Plugin hooks are auto-discovered when the plugin is installed. The trust gate is different on every host.

| Host   | Discovered at install? | Extra trust step                                                                              |
| ------ | ---------------------- | --------------------------------------------------------------------------------------------- |
| Claude | yes                    | none — `plugin install` IS the trust act                                                      |
| Codex  | only with opt-in       | `[features] plugin_hooks = true` in `~/.codex/config.toml` + per-hook review via `/hooks` CLI |
| Gemini | yes                    | none documented — `gemini extensions install` IS the trust act                                |

Codex is the strict one. The opt-in is global; without `[features] plugin_hooks = true` the plugin's `hooks` block in
`.codex-plugin/plugin.json` is never read, and the user sees no error — the hooks silently don't exist. The `/hooks` CLI
menu lets users review, trust, or disable individual hooks after install.

Project-local and user-layer hook configs still exist (`.claude/settings.json`, `.codex/config.toml`,
`.gemini/settings.json`) — this doc is about the plugin layer, the wiring that travels with the install.

---

## Read it in code

`devscripts/format-on-edit.ts` is the canonical implementation. Read stdin once, decide quickly, exit `0` even on
internal failure unless the agent _must_ be stopped. See [BEST_PRACTICES.md](BEST_PRACTICES.md) for why.

---

## Quick checklist

```
Plug-in       ── JSON on stdin · JSON on stdout · exit 0 success / 2 block / other = warning
Events        ── Pre/Post (Claude/Codex) vs Before/After (Gemini); remap by role
Matchers      ── tool_name match; Claude flips on regex when non-word chars appear
Stdin         ── session_id · transcript_path · cwd · hook_event_name + event-specific
Stdout        ── continue · stopReason · systemMessage · suppressOutput + decision payload
Decision      ── permissionDecision (Claude PreToolUse); decision: block (most others)
Nesting       ── `hookSpecificOutput` wraps `additionalContext` on all three; Codex/Gemini keep `decision`/`reason` top-level (Claude wraps those too)
Handlers      ── only `command` runs on all three; http/prompt/agent are Claude-only execute
Tool aliasing ── Codex matcher accepts Edit/Write for apply_patch; tool_name reports apply_patch
Config file   ── inline `hooks` block in each host's native manifest (one script, three wirings)
Plugin root   ── ${CLAUDE_PLUGIN_ROOT} (Claude · Codex alias) · ${extensionPath} (Gemini)
Codex opt-in  ── [features] plugin_hooks = true in ~/.codex/config.toml — hooks silently skip otherwise
Codex trust   ── per-hook review via /hooks CLI menu (not the project-trust gate)
```

[1]: https://code.claude.com/docs/en/hooks
