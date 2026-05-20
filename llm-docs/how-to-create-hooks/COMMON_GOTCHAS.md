# Common gotchas

Plugin-shipped hooks look identical on paper, then bite in production. Most pain comes from a silent semantic gap
between hosts.

______________________________________________________________________

## Event names diverge by host

Claude and Codex use `PreToolUse` / `PostToolUse`. Gemini uses `BeforeTool` / `AfterTool`. Wire the Claude/Codex
manifests but forget Gemini's, and the hook silently doesn't fire there.

```jsonc
// Avoid — Claude/Codex manifests wired; gemini-extension.json bare
// .claude-plugin/plugin.json
{ "hooks": { "PostToolUse": [ ... ] } }
// gemini-extension.json
{ "name": "...", "version": "..." }          // no hooks block → Gemini reads nothing

// Prefer — each manifest carries its own hooks block with its event name
// .claude-plugin/plugin.json — Claude
{ "hooks": { "PostToolUse": [ ... ] } }
// .codex-plugin/plugin.json — Codex
{ "hooks": { "PostToolUse": [ ... ] } }
// gemini-extension.json — Gemini
{ "hooks": { "AfterTool":   [ ... ] } }
```

Treat events as semantic roles. The translation table lives in [HOOK_CONTRACT.md](HOOK_CONTRACT.md#event-catalog).

______________________________________________________________________

## Tool names are aliased differently

`Edit` and `Write` on Claude become `apply_patch` on Codex and `write_file` / `replace` on Gemini (Gemini's "Edit" is
just the display name of `replace`, not a tool name). A matcher hardcoded to `Edit` silently misses every Codex edit.

| Intent             | Claude matcher             | Codex matcher                | Gemini matcher        |
| ------------------ | -------------------------- | ---------------------------- | --------------------- |
| Any file-edit tool | `(Edit\|Write\|MultiEdit)` | `(apply_patch\|Edit\|Write)` | `(write_.*\|replace)` |
| Shell              | `Bash`                     | `Bash`                       | `run_shell_command`   |
| Any MCP tool       | `mcp__.*`                  | `mcp__.*`                    | `mcp_.*`              |

Codex accepts `Edit` and `Write` as matcher *aliases* for `apply_patch` — but the `tool_name` in the payload is always
`apply_patch`. If your script inspects `tool_name`, branch on that, not on what the matcher said.

______________________________________________________________________

## `additionalContext` and `updatedInput` nesting differs

Where structured fields live depends on the host. Drop the wrong nesting and the host parses your JSON but ignores the
field — no error, no warning.

| Field                         | Claude                                  | Codex     | Gemini                                 |
| ----------------------------- | --------------------------------------- | --------- | -------------------------------------- |
| `additionalContext`           | `hookSpecificOutput.additionalContext`  | top-level | `hookSpecificOutput.additionalContext` |
| `updatedInput` (PreToolUse)   | `hookSpecificOutput.updatedInput`       | top-level | `hookSpecificOutput.tool_input`        |
| `permissionDecision`          | `hookSpecificOutput.permissionDecision` | —         | `decision`                             |
| `hookEventName` discriminator | required inside `hookSpecificOutput`    | —         | required inside `hookSpecificOutput`   |

Smoke-test the JSON shape per host. A hook "working everywhere" can be silently no-op'ing on two of the three.

______________________________________________________________________

## Codex plugin hooks need explicit opt-in

A freshly-installed Codex plugin's `hooks` block (in `.codex-plugin/plugin.json`) is silently ignored unless the user
has flipped a feature flag in their global config. There is no error and no warning — the plugin looks installed, the
hooks just never fire.

```toml
# ~/.codex/config.toml — required, once per machine
[features]
plugin_hooks = true
```

Codex also presents each hook for review on first invocation via the `/hooks` CLI menu (trust / review / disable per
hook). This is a *separate* trust gate from the project-trust mechanism that controls `.codex/config.toml` — installing
the plugin and trusting the project does not auto-trust the hooks inside. Document both steps in the plugin README.

______________________________________________________________________

## Plugin-root placeholder differs on Gemini

Claude and Codex share the `${CLAUDE_PLUGIN_ROOT}` placeholder (Codex aliases it to its native `${PLUGIN_ROOT}`). Gemini
recognizes neither — it has `${extensionPath}` instead. Each manifest carries its own `hooks` block, so keep Claude /
Codex using `${CLAUDE_PLUGIN_ROOT}` and Gemini using `${extensionPath}` in their respective files.

```jsonc
// Avoid — ${CLAUDE_PLUGIN_ROOT} in gemini-extension.json doesn't resolve, command path breaks
// gemini-extension.json
{
  "hooks": {
    "AfterTool": [{
      "matcher": "(write_.*|replace)",
      "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/<name>_hook.py" }]
    }]
  }
}

// Prefer — Gemini manifest uses ${extensionPath}
// gemini-extension.json
{
  "hooks": {
    "AfterTool": [{
      "matcher": "(write_.*|replace)",
      "hooks": [{ "type": "command", "command": "${extensionPath}/scripts/<name>_hook.py" }]
    }]
  }
}
```

Or compute the root inside the script (`Path(__file__).resolve().parents[1]`) and keep the placeholder only for the
`command` path itself.

______________________________________________________________________

## Anything on stdout breaks the decision

The host parses stdout as JSON. *One stray byte* — a debug print, a `set -x`, an rc-file welcome banner — and the parser
silently treats the hook as having no decision.

```python
# Avoid — print() lands on stdout
print(f"formatting {path}")
print(json.dumps({"continue": True}))

# Prefer — logs go to stderr; only the JSON (or nothing) on stdout
print(f"formatting {path}", file=sys.stderr)
sys.stdout.write(json.dumps({"continue": True}))
```

```bash
# Avoid — interactive shell rc files pollute stdout
#!/bin/bash
# ~/.bashrc may echo "Welcome…" → lands on stdout → broken JSON

# Prefer — no rc files; explicit interpreter
#!/bin/bash --noprofile --norc
```

Shell hooks are the worst offenders. Prefer Python, Node, or `bash --noprofile --norc`.

______________________________________________________________________

## A hung hook hangs the agent's turn

The host blocks the agent's turn until the hook returns or times out. Default timeouts vary; some events have no
default. A hook that calls `curl` against a slow endpoint locks the user out.

```python
# Avoid — no timeout; one bad day at the registry kills every edit
subprocess.run(["uv", "run", "ruff", "format", path])

# Prefer — bound the wait, accept the failure
try:
    subprocess.run(["uv", "run", "ruff", "format", path], timeout=30, check=False)
except subprocess.TimeoutExpired:
    print("format hook timed out", file=sys.stderr)
return 0
```

Always set a `timeout` in config *and* `timeout=` in the script's subprocess calls. Belt and braces — the inner timeout
fires first and lets you log; the outer one is the host's safety net.

______________________________________________________________________

## `decision: block` on PostToolUse does not un-run the tool

`PostToolUse` runs *after* the tool succeeded. The side effect already happened. Blocking only stops the *next* model
call — useful for "tests failed, don't keep coding," but useless for "undo what just happened."

```jsonc
// Avoid — expects the tool to be reverted; it won't be
// PostToolUse on a Write that created /tmp/leaked.txt
{ "decision": "block", "reason": "secrets in file" }
// → file already exists; only the next turn is blocked
```

For real prevention, intercept at `PreToolUse` / `BeforeTool` and deny there. For cleanup-after, do the cleanup inside
the `PostToolUse` hook itself — the host won't do it for you.

______________________________________________________________________

## Hooks fire repeatedly per turn

A `PostToolUse` hook on `(Edit|Write|MultiEdit)` fires three times in a `MultiEdit` batch. A non-idempotent action runs
three times. A log line emits three times. A CI trigger… you can see where this goes.

```python
# Avoid — every Edit posts a fresh Slack message
slack.post(f"edited {path}")

# Prefer — coalesce per-turn via a marker file or per-payload hash
seen = _marker_read()
if payload["session_id"] in seen:
    return 0
_marker_write(payload["session_id"])
slack.post(f"edited {path}")
```

Idempotency is not a "nice to have" for hooks — it's the only way to handle the host's natural fan-out.

______________________________________________________________________

## `type: prompt` / `agent` / `async` parse but don't run

Codex parses these handler types out of legacy config but doesn't execute them. Gemini doesn't have them in the spec at
all. A cross-host hook that depends on them looks like it ports — until it silently does nothing on two hosts.

```jsonc
// Avoid — Claude-only handler
{ "type": "prompt", "prompt": "Summarize the change for the user." }

// Prefer — type: "command" runs on all three
{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/hooks/summarize.py" }
```

If the plugin is Claude-only on purpose, name it so in the README. Cross-host plugins stay on `command`.

______________________________________________________________________

## Claude matcher silently switches into regex mode

Claude's matcher uses *either* an exact-string list (letters/digits/`_`/`|`) *or* JS RegExp — and it decides based on
the characters present.

```jsonc
{ "matcher": "Edit|Write" }                // exact-string list: matches `Edit` or `Write`
{ "matcher": "Edit|Write.*" }              // regex mode: `.*` matches anything after Write
{ "matcher": "(Edit|Write)" }              // regex mode: parentheses flip it on
```

The third form behaves the same as the first, but adding `?` or `\b` will change matching. If the matcher contains
anything beyond `[A-Za-z0-9_|]`, write it as a regex and test it.

______________________________________________________________________

## Plugin vars don't survive a copy to the project layer

`${CLAUDE_PLUGIN_ROOT}` (Claude · Codex) and `${extensionPath}` (Gemini) are only set when the hook ships *inside* an
installed plugin. Copy the same `hooks` block from a plugin manifest into a project-local config
(`.claude/settings.json`, `.codex/config.toml`, `.gemini/settings.json`) and the placeholders resolve to empty strings —
the command path turns into `/scripts/<name>_hook.py`, no script found.

| Hook location                           | `CLAUDE_PLUGIN_ROOT` | `PLUGIN_ROOT` (Codex) | `extensionPath` |
| --------------------------------------- | -------------------- | --------------------- | --------------- |
| Plugin manifest `hooks` block           | set                  | set                   | set             |
| `.claude/settings.json` (project-local) | —                    | —                     | —               |
| `~/.claude/settings.json` (user layer)  | —                    | —                     | —               |

If a hook needs to live at the project or user layer instead, compute the root inside the script
(`Path(__file__).resolve().parents[1]`) and drop the placeholder from the config.

______________________________________________________________________

## Hooks fail silently when the interpreter isn't on PATH

`#!/usr/bin/env python3` requires `python3` on the user's PATH. `uv run …` requires `uv` to be installed. The host
doesn't warn — the hook just doesn't run, the agent does its thing, you wonder why nothing formatted.

```python
# Avoid — assumes uv is on PATH everywhere
subprocess.run(["uv", "run", "ruff", "format", path])

# Prefer — fail loudly to stderr so the user sees it
try:
    subprocess.run(["uv", "run", "ruff", "format", path], check=False)
except FileNotFoundError as exc:
    print(f"format hook: {exc} — is `uv` installed?", file=sys.stderr)
```

Document the binaries the hook expects in the plugin's README. CI doesn't catch missing dev deps the way a `Makefile`
would.

______________________________________________________________________

## `tool_response` shape differs after the call

`PostToolUse` payloads include the tool's output, but the shape diverges. Claude/Codex give you `stdout` / `stderr` /
`exit_code`. Gemini gives you `llmContent` and `returnDisplay`.

```jsonc
// Claude / Codex — Bash response
"tool_response": { "stdout": "...", "stderr": "...", "exit_code": 0 }

// Gemini — Bash response
"tool_response": { "llmContent": "...", "returnDisplay": "...", "error": null }
```

A hook that decides on stdout content needs two parsers, or a wrapper that normalizes. Pick the host's native shape and
document the assumption in the script.

______________________________________________________________________

## Quick checklist

```
Event names    ── Pre/Post (Claude/Codex) vs Before/After (Gemini); wire each in its own manifest `hooks` block
Tool names     ── Edit ≠ apply_patch ≠ write_file; combine Claude+Codex in one matcher
Nesting        ── hookSpecificOutput on Claude/Gemini; top-level on Codex
Codex opt-in   ── [features] plugin_hooks = true required, or `.codex-plugin/plugin.json` hooks silently skipped
Codex trust    ── per-hook review via /hooks CLI (separate from project trust)
Plugin root    ── ${CLAUDE_PLUGIN_ROOT} on Claude/Codex; ${extensionPath} on Gemini — split the entries
Stdout         ── only JSON; profile chatter + print() break the parser
Timeouts       ── set in config and in subprocess; the host won't wait forever
Post-decision  ── PostToolUse block stops the next turn, not the side effect
Fan-out        ── hooks fire N times per turn; design idempotently
Handler types  ── only `command` runs on all three; prompt/agent/async are Claude-only
Matcher mode   ── Claude flips into regex when non-word chars appear; test it
Plugin vars    ── placeholders empty if you copy hooks.json to .claude/.codex/.gemini settings
Interpreter    ── missing python/uv silently no-ops; fail loudly on FileNotFoundError
Tool response  ── stdout/exit_code (Claude/Codex) vs llmContent (Gemini); branch per host
```
