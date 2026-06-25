# Best practices

Patterns that keep plugin-shipped hooks fast, predictable, and portable across Claude, Codex, and Gemini. A hook runs in
the agent's hot loop — every millisecond is the user's wall-clock latency.

---

## Pick the right event

Choose by _when you can still act_. A hook that wants to block belongs before the action; a hook that wants to react
belongs after.

| Intent                                    | Use                                           |
| ----------------------------------------- | --------------------------------------------- |
| Stop a tool call before it runs           | `PreToolUse` / `BeforeTool`                   |
| Modify the tool input before it runs      | `PreToolUse` / `BeforeTool` (`updatedInput`)  |
| Run side effects after a tool succeeds    | `PostToolUse` / `AfterTool`                   |
| Stop the next model turn on a bad result  | `PostToolUse` / `AfterTool` (decision: block) |
| Inject context once per session           | `SessionStart`                                |
| Validate or augment user prompts          | `UserPromptSubmit` / `BeforeAgent`            |
| Resist a `Stop` to keep the agent working | `Stop` (Claude/Codex), `AfterAgent` (Gemini)  |

A `PostToolUse` hook _cannot_ prevent the tool that just ran — only the next model call. If you need a real veto, you
need the pre-event. The cost of getting this wrong is silent: the agent acts, the hook complains, the side effect
already happened.

---

## Stay fast

The hook sits in the user's wall clock. Aim for under 100 ms on the happy path; the host kills you when the configured
timeout expires (defaults differ per host — always set yours explicitly).

```ts
// Avoid — formats every file in the repo on every edit
const payload = JSON.parse(await Bun.stdin.text());
await spawn(["biome", "format", "--write", "."]); // whole tree

// Prefer — formats only the file the agent just touched
const payload = JSON.parse(await Bun.stdin.text());
const path = (payload.tool_input as { file_path?: string } | undefined)?.file_path;
if (!path) process.exit(0);
await spawn(["biome", "format", "--write", path], { timeoutMs: 30_000 });
```

Filter aggressively in the _matcher_ (the host skips spawning the hook at all) and in the _first lines_ of the script
(cheap guards over expensive work).

---

## Set the timeout explicitly

Defaults vary by host and event. A hook that takes longer than expected gets killed mid-write, leaving the workspace
dirty.

```jsonc
// In each manifest's `hooks` block — same field on all three hosts
{ "type": "command", "command": "...", "timeout": 30 } // seconds
```

Pick a timeout you can defend: the 99th-percentile runtime under load, plus headroom. Format-on-save: 30 s.
Lint-and-block: 5 s. Sentinel-fast checks: 1 s.

---

## Stdout is the JSON channel — nothing else

The host parses stdout as JSON on exit 0. _Anything else_ you print to stdout is one malformed character away from
killing the decision payload.

```ts
// Avoid — console.log() pollutes stdout; the JSON the host reads is broken
console.log("running format-on-edit…"); // → stdout, breaks JSON
const payload = JSON.parse(await Bun.stdin.text());
process.stdout.write(JSON.stringify({ continue: true }));

// Prefer — logs to stderr, only the final JSON (or nothing) on stdout
process.stderr.write("running format-on-edit…\n");
const payload = JSON.parse(await Bun.stdin.text());
process.stdout.write(JSON.stringify({ continue: true }));
```

Shell scripts are worse — your `~/.bashrc` may print a welcome banner that lands on stdout. Run hook commands with
`bash --noprofile --norc`, or use a language without rc pollution. The same trap bites `set -x`, `pip` install lines,
and `nvm use` chatter.

---

## Be idempotent

The same hook fires repeatedly during one turn — once per `Edit`, once per `MultiEdit`, once per file in a batch. Design
the side effect so that running it again is a no-op.

| Action                        | Idempotent? | Why                                       |
| ----------------------------- | ----------- | ----------------------------------------- |
| `biome format --write <path>` | yes         | Re-running on a formatted file is a no-op |
| `prettier --write <path>`     | yes         | Same                                      |
| Append to a log file          | no          | Two edits → two log lines                 |
| Trigger a CI run              | no          | Two edits → two CI runs                   |
| Apply a one-shot config       | no          | Second run rewrites with stale state      |

If the action isn't naturally idempotent, _make_ it idempotent: hash the input, write a sentinel file, or skip when
nothing changed.

```ts
// Avoid — fires N times in a multi-file batch
notifySlack("file changed");

// Prefer — only fire once per batch
const last = readMarker();
const now = hashPayload(payload);
if (last === now) process.exit(0);
writeMarker(now);
notifySlack("file changed");
```

---

## Default to non-blocking

Most hooks are _advisory_ — formatters, linters, log emitters. They should never break an edit because the formatter
wasn't installed.

```ts
// Avoid — formatter missing crashes the agent's edit
const { exitCode } = await spawn(cmd);
if (exitCode !== 0) throw new Error(`format failed: ${exitCode}`);

// Prefer — formatter missing warns and continues
try {
  await spawn(cmd, { timeoutMs: 30_000 });
} catch (exc) {
  process.stderr.write(`format hook: ${exc instanceof Error ? exc.message : String(exc)}\n`);
}
process.exit(0); // always proceed
```

Reserve exit `2` (or the host's structured deny — see [HOOK_CONTRACT.md](HOOK_CONTRACT.md#stdout-decision-payload)) for
hooks whose _job_ is to block: secrets scanners, policy gates, destructive-command guards. Everything else exits `0`
even when it failed.

---

## Least-privilege matchers

Narrow the matcher to the exact tools you care about. A wide matcher spawns the hook for every irrelevant call and adds
latency to every turn.

```jsonc
// Avoid — fires on every tool call, including Read and Bash
{ "matcher": ".*", "hooks": [{ "type": "command", "command": "...format-on-edit.ts" }] }
// (a bare "*" is invalid regex — JS RegExp rejects it; use ".*" or omit the matcher)

// Prefer — each manifest carries only its host's tool names
// .claude-plugin/plugin.json — Claude
{ "matcher": "(Edit|Write|MultiEdit)", "hooks": [...] }

// .codex-plugin/plugin.json — Codex (Edit/Write are matcher aliases for apply_patch)
{ "matcher": "(apply_patch|Edit|Write)", "hooks": [...] }

// gemini-extension.json — Gemini
{ "matcher": "(write_.*|replace)", "hooks": [...] }
```

Tool names diverge across hosts. Each manifest carries its own matcher matching only that host's tool names — the
divergence sits in three separate files, so no manifest carries names another host wouldn't recognize.

---

## One script, wired per manifest

Keep the hook's _logic_ in one shared file (`<plugin>/scripts/<name>.ts`). Wire it from each host's native manifest —
the script is the single source of truth; the wiring naturally diverges because each host has its own placeholder and
event-name vocabulary.

```
<plugin>/
├── .claude-plugin/plugin.json       ── Claude manifest + inline `hooks` block
├── .codex-plugin/plugin.json        ── Codex manifest + inline `hooks` block
├── gemini-extension.json            ── Gemini manifest + inline `hooks` block (at root)
└── scripts/
    └── <name>.ts                    ── single source of truth
```

The script reads `payload.tool_input.file_path` — that key shape is the _only_ host detail it cares about, and it's the
same on all three. Each manifest has its own entry (event name + matcher + placeholder); the logic doesn't branch.

---

## Use the plugin-root placeholder

Each host exposes its plugin root through a placeholder. Use the right one in each event block; let the script learn its
own location from `import.meta.url` if it needs to load sibling resources.

| Host   | Placeholder in manifest `hooks` block | Env var inside the script     |
| ------ | ------------------------------------- | ----------------------------- |
| Claude | `${CLAUDE_PLUGIN_ROOT}`               | `CLAUDE_PLUGIN_ROOT`          |
| Codex  | `${CLAUDE_PLUGIN_ROOT}` (alias)       | `PLUGIN_ROOT` (also aliased)  |
| Gemini | `${extensionPath}`                    | `extensionPath` (best-effort) |

```jsonc
// .claude-plugin/plugin.json + .codex-plugin/plugin.json — Codex aliases ${CLAUDE_PLUGIN_ROOT}
"command": "${CLAUDE_PLUGIN_ROOT}/scripts/<name>.ts"

// gemini-extension.json — Gemini uses ${extensionPath}
"command": "${extensionPath}/scripts/<name>.ts"
```

```ts
// Inside the hook — works regardless of host
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // walk up: scripts/<name>.ts → plugin root
```

Computing the root inside the script removes one host-specific knob from every config. Use the env-var placeholder only
in the `command` string itself, where the host has no other way to point at the plugin.

---

## Validate inputs at the boundary

The hook is a boundary. The payload comes from the host; the file paths come from the model. Don't pass them straight
into a shell.

```ts
// Avoid — model-supplied path interpolated into a shell command
await spawn(["sh", "-c", `biome format --write ${payload.tool_input.file_path}`]);

// Prefer — argv list, no shell, resolved absolute path
const path = resolve(payload.tool_input.file_path);
if (!(await exists(path)) || !(await stat(path)).isFile() || !insideRepo(path)) process.exit(0);
await spawn(["biome", "format", "--write", path]);
```

A `PreToolUse` hook that runs the same shell command the model just proposed is a confused deputy. Always validate path,
type, and scope before acting.

---

## Test the contract on every host

A hook is a contract test against three hosts. Smoke-test it with each host's payload shape — same script, three
invocations. A hook that passes one shape and silently no-ops on the other two is the failure mode.

```bash
# Claude — PostToolUse
echo '{"session_id":"t","transcript_path":"/tmp/x","cwd":"/tmp",
       "hook_event_name":"PostToolUse","tool_name":"Edit",
       "tool_input":{"file_path":"/tmp/sample.ts"}}' \
  | scripts/format-on-edit.ts ; echo "exit=$?"

# Codex — PostToolUse, tool_name is apply_patch (not Edit/Write)
echo '{"session_id":"t","transcript_path":"/tmp/x","cwd":"/tmp",
       "hook_event_name":"PostToolUse","tool_name":"apply_patch",
       "tool_input":{"file_path":"/tmp/sample.ts"}}' \
  | scripts/format-on-edit.ts ; echo "exit=$?"

# Gemini — AfterTool, includes timestamp, tool_name is write_file
echo '{"session_id":"t","transcript_path":"/tmp/x","cwd":"/tmp",
       "hook_event_name":"AfterTool","timestamp":"2026-05-21T12:00:00Z",
       "tool_name":"write_file","tool_input":{"file_path":"/tmp/sample.ts"}}' \
  | scripts/format-on-edit.ts ; echo "exit=$?"
```

If the script branches on `hook_event_name` or `tool_name`, the three smokes catch the branch before the agent does. If
it doesn't branch, the three smokes confirm that — also useful.

---

## Document the contract in the script

Hooks are invisible at the call site. The script's header comment is the only place a future reader sees _which_ event
fires it, _which_ host wires it up, and _what_ it returns.

```ts
/**
 * Format the file just edited by an agent.
 *
 * Wired inline in each host's manifest hooks block:
 *   .claude-plugin/plugin.json   PostToolUse  matcher (Edit|Write|MultiEdit)     — Claude
 *   .codex-plugin/plugin.json    PostToolUse  matcher (apply_patch|Edit|Write)   — Codex
 *   gemini-extension.json        AfterTool    matcher (write_.*|replace)         — Gemini
 *
 * Always exits 0 — formatter failures warn on stderr but never block the agent's edit.
 */
```

Three lines beat ten minutes of "where does this fire from?" later. Update the comment when you re-wire an entry.

---

## Quick checklist

```
Event         ── Pre/Before to gate · Post/After to react; post-events cannot un-run the tool
Speed         ── filter in the matcher; cheap guards first; aim under 100 ms happy path
Timeout       ── set it explicitly; defaults differ per host; defend the number against p99 runtime
Stdout        ── only JSON; everything else goes to stderr (including profile chatter)
Idempotency   ── same hook may fire N times per turn; design the side effect to be safe
Blocking      ── default exit 0; reserve exit 2 / host deny-envelope for real policy gates
Matchers      ── exact tools; combine Claude + Codex names in one PostToolUse entry; Gemini in AfterTool
One script    ── logic in <plugin>/scripts/<name>.ts; wiring inline in each host's manifest `hooks` block
Plugin root   ── ${CLAUDE_PLUGIN_ROOT} (Claude · Codex alias) · ${extensionPath} (Gemini)
In-script root── dirname(dirname(fileURLToPath(import.meta.url))) — scripts/<name>.ts → plugin root
Validation    ── re-check paths inside the hook; never shell-out unsanitized model input
Smoke test    ── pipe one sample payload per host through the script before shipping
Header comment── name the events, matchers, and configs the script is wired into
```
