# Common patterns

Named orchestration patterns that work on Claude Code, Codex, and Gemini CLI. The mechanism diverges per host — the
shape doesn't. Patterns that don't survive on all three are excluded by design (see the closing section).

---

## Direct

The skill body executes the work in the assistant's own turn. No worker, no delegation, no hook.

| Host   | Mechanism                          |
| ------ | ---------------------------------- |
| Claude | skill loads, assistant runs inline |
| Codex  | same                               |
| Gemini | same                               |

**Use when:** the work fits in one turn — read a file, run one command, summarize. The body's instructions are enough
for the model to execute directly.

**Don't use when:** strict tool scope needed (use Trampoline), heavy data gathering would pollute parent context, or the
task needs a cold-open second opinion.

```text
user → skill body → assistant reply
       (no agent boundary)
```

---

## Trampoline

The skill exists _only_ to launch a worker. The skill prints an announce line; the worker does the work; the worker's
output is what the user sees.

| Host   | Mechanism                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------- |
| Claude | `Agent({ subagent_type: "<worker>", prompt: "<brief>" })`                                                     |
| Codex  | model fires Codex's subagent surface against a built-in (`default`/`worker`/`explorer`) or registered `.toml` |
| Gemini | `SubagentInvocation` tool call (model-initiated), or user types `@<worker> <brief>`                           |

**Use when:** the worker needs a cold open (adversarial review, isolated context), strict tool scope, or heavy data
gathering that shouldn't land in the parent's context.

**Don't use when:** the work fits inline — use Direct.

```text
user → skill body → "delegate to <worker>" → worker runs → worker reply IS the output
                                                            (no parent post-processing)
```

**Phrase intent, never the call.** A skill body that hard-codes `Agent(...)` is Claude-only; one that hard-codes
`@worker` is Gemini-only. Write `"delegate to the <worker> worker with this brief: ..."` and let each host resolve to
its native primitive.

---

## Cold-Open Refinement

Multi-turn user iteration on a worker's draft output, **without preserving worker state across turns**. Each iteration
spawns a fresh worker with prior outputs and user feedback replayed in the brief.

| Host   | Mechanism                                                                                    |
| ------ | -------------------------------------------------------------------------------------------- |
| Claude | parent spawns new `Agent({...})` per iteration; full prior context in `prompt`               |
| Codex  | parent re-spawns the subagent each turn with prior context in the brief; no mid-thread state |
| Gemini | same via `SubagentInvocation` or `@<worker>`; user supplies feedback as a fresh invocation   |

**Use when:** the user iterates on a draft — "make it shorter", "add a security section", "change the tone". Each round
refines without needing in-worker state.

**Don't use when:** the agent has working memory worth preserving across turns (long chain-of-thought built up over a
planning session). On Claude that's **Resumable Agent**, which is faster and cheaper — but Claude-only.

```text
turn 1: parent → worker(brief)                          → output_1
turn 2: parent → worker(brief + output_1 + feedback_1)  → output_2
turn 3: parent → worker(brief + output_2 + feedback_2)  → output_3
```

**Cost model:** each iteration replays the full prior context. A 5-turn refinement on a 10k-token brief pays ~30k tokens
cumulative (vs. ~10k for Claude's Resumable Agent). Bound iteration count; for unbounded loops, this gets expensive
fast.

**Compaction trick:** between iterations, summarize the prior output instead of replaying it verbatim. Trades fidelity
for cost.

---

## Parallel Agents

The parent fans out N specialist workers — same input, different focus — and merges their reports.

| Host   | Mechanism                                                                                    | Status                                                                  |
| ------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Claude | parent emits N `Agent({...})` calls in a single message                                      | stable                                                                  |
| Codex  | `spawn_agents_on_csv` + per-worker `report_agent_job_result` for batch fan-out               | enabled by default — one row per worker                                 |
| Gemini | model emits N `SubagentInvocation` tool calls in one response, or user types `@a ... @b ...` | **experimental** — read-only safe; write workloads risk race conditions |

**Use when:** the same artifact needs multiple independent perspectives — security review, perf review, correctness
review on the same diff. Merge the findings by severity, not by source agent.

**Don't use when:** workers need each other's intermediate output (that's Team, which isn't portable), or each worker
processes a different input (that's Parent Fan-Out — one worker, N inputs).

```text
parent ──▶ security_reviewer    (input: diff)
       ──▶ perf_reviewer         (input: diff)
       ──▶ correctness_reviewer  (input: diff)
       ◀── merge by severity
```

**Gemini write hygiene:** never run parallel subagents that mutate shared files — the official docs flag this as a
race-condition risk. Parallel reads (analysis, lint, audit) are safe; parallel writes (codegen, refactor) are not.

**Tag every reply** — order of return is not guaranteed; merging on prose summaries is guesswork. The Stamped Results
discipline applies here too.

---

## Parent Fan-Out

When N independent targets need the same worker, the parent skill fans out — never the worker. Workers don't spawn
workers.

| Host   | Mechanism                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------- |
| Claude | parent fires N `Agent({...})` calls in parallel                                                |
| Codex  | `spawn_agents_on_csv` for batch, or parent iterates N calls; cap with `[agents] max_depth = 1` |
| Gemini | host blocks worker→worker by spec; parent or user fans out manually                            |

**Use when:** the same brief applies to N inputs (review each changed file, lint each module).

**Don't use when:** the work fits in one Trampoline call, or workers actually need to coordinate during execution.

```text
parent ──▶ worker_a            ── legal: parent fans out
       ──▶ worker_b
       ──▶ worker_c
       ◀── merge by `target`

parent ──▶ worker_a ──▶ worker_b   ── DON'T: blocked on Gemini, dangerous everywhere
```

**Discipline rule:** if the design needs depth, build it as sibling fan-out from the parent, not as a chain. Cost
compounds on Claude/Codex; the inner branch silently disappears on Gemini.

---

## Stamped Results

Every worker reply carries the input it processed. The parent merges by key — order of return is not guaranteed on any
host.

| Host   | Mechanism                                                        |
| ------ | ---------------------------------------------------------------- |
| Claude | return-shape convention                                          |
| Codex  | same — `spawn_agents_on_csv` row index ≠ return index            |
| Gemini | same — user fires N invocations; stamping lets them scan results |

**Use when:** any fan-out, any merge step.

**Don't use when:** there's exactly one worker call — the input is implicit.

```json
{ "agent": "reviewer", "target": "src/payments.ts", "findings": [...] }
{ "agent": "reviewer", "target": "src/billing.ts",  "findings": [...] }
```

Parent collects by `target`. A worker that doesn't stamp forces the parent to guess which result came from which input.

---

## Action Dispatch

The skill ends its report with a numbered action menu. The user types a key (`E 3` or `explain 3`); the model responds
in-conversation, using the prior turn's menu as context. No host primitive — pure markdown.

| Host   | Mechanism                                         |
| ------ | ------------------------------------------------- |
| Claude | conversation context + skill `## Actions` section |
| Codex  | conversation context                              |
| Gemini | conversation context                              |

**Use when:** the skill produces a list of findings or options where the user might want different actions per item.

**Don't use when:** there's no follow-up — present the result and stop.

```text
────────────────────────────────────────────────────────────────────
▸ [E]xplain #N     ▸ [D]ismiss #N     ▸ [V]erify
```

**Input parsing rules:**

- Case-insensitive.
- Accept short key and spelled-out word — `E 3` and `explain 3` are equivalent.
- Accept multiple indices in one invocation — `E 1 3 7`.

The menu lives in the prior assistant turn. The user's next message is interpreted against it; the model picks the
matching action.

---

## Prompt Intercept

A slash command handled entirely by a hook — no model turn is consumed. The hook does the work as a side effect and
emits a message the user sees.

| Host   | Hook event         | Block mechanism                                                                                                        |
| ------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Claude | `UserPromptSubmit` | `{"decision": "block", "reason": "<message>"}` on stdout                                                               |
| Codex  | `UserPromptSubmit` | `exit 2` + reason on stderr (NOT `decision: block` JSON — that creates a continuation prompt and the model still runs) |
| Gemini | `BeforeAgent`      | `{"decision": "deny", "reason": "<message>", "systemMessage": "<message>"}`                                            |

**Use when:** the command is a pure side effect — clipboard copy, file write, toggle a setting, external API call. No
reasoning required.

**Don't use when:** the command needs the model to think — use a skill.

```ts
// Avoid — same envelope on every host; Codex turns this into a continuation prompt
console.log(JSON.stringify({ decision: "block", reason: message }));

// Prefer — pick the envelope per host
const host = detectHost(payload);
if (host === "codex") {
  process.stderr.write(`${message}\n`);
  process.exit(2);
} else if (host === "gemini") {
  console.log(JSON.stringify({ decision: "deny", reason: message, systemMessage: message }));
} else {
  // claude
  console.log(JSON.stringify({ decision: "block", reason: message }));
}
```

Three pieces required regardless of host:

1. **Stub command** — `commands/<name>.md` (Claude/Codex) and `commands/<name>.toml` (Gemini). Registers the slash
   command in `/help`. The body is a fallback message shown only if the hook fails to intercept.
2. **Hook config** — wires `UserPromptSubmit` (Claude/Codex) and `BeforeAgent` (Gemini) to the script.
3. **Hook script** — matches the command, does the work, emits the host-specific block envelope. Always check your
   command first and pass unmatched prompts through with `print("{}")` — never block prompts that aren't yours.

---

## Adapter Hook

A hook script that detects which host invoked it and emits the right envelope. One file, three audiences.

| Signal                                                             | Host   |
| ------------------------------------------------------------------ | ------ |
| `hook_event_name` starts with `Before` / `After`                   | Gemini |
| `PLUGIN_ROOT` env var set (Codex's native — Claude doesn't set it) | Codex  |
| else                                                               | Claude |

`hook_event_name` alone is ambiguous — both Claude and Codex report `PreToolUse`. Check `PLUGIN_ROOT` to disambiguate;
Codex aliases `CLAUDE_PLUGIN_ROOT` to it, but only Codex sets `PLUGIN_ROOT` _natively_.

```ts
type Payload = { hook_event_name?: string };

const detectHost = (payload: Payload): "claude" | "codex" | "gemini" => {
  const event = payload.hook_event_name ?? "";
  if (event.startsWith("Before") || event.startsWith("After")) return "gemini";
  if ("PLUGIN_ROOT" in process.env) return "codex";
  return "claude";
};

const emitDeny = (payload: Payload, reason: string): void => {
  const host = detectHost(payload);
  let envelope: unknown;
  if (host === "claude") {
    envelope = {
      hookSpecificOutput: {
        hookEventName: payload.hook_event_name,
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  } else if (host === "gemini") {
    envelope = { decision: "deny", reason };
  } else {
    // codex
    envelope = { decision: "block", reason };
  }
  process.stdout.write(JSON.stringify(envelope));
};
```

**Use when:** a single hook script ships for all three hosts and the decision envelope differs (`PreToolUse` deny,
`additionalContext` injection, `updatedInput` rewrites).

**Don't use when:** the hook is advisory (formatter, linter) — exit 0 with empty stdout works everywhere. Adapter logic
is only needed when the hook actually shapes the host's behavior.

**Block reason:** the text stays the same across hosts; only the envelope changes. A clear reason is the difference
between _the model retries successfully_ and _the model loops re-asking permission_.

---

## Patterns we deliberately cut

These exist on Claude (and sometimes Codex) but don't survive on all three hosts. A future contributor who reaches for
them in a cross-host context will silently lose behavior on one or two hosts.

| Pattern                                        | Why it doesn't port                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Team** (TeamCreate, SendMessage, TeamDelete) | Real-time peer-to-peer messaging between agents is Claude-only. Codex subagents are parent-mediated (the parent shuttles messages, no peer-to-peer); Gemini has no inter-agent comms at all. The filesystem-as-state workaround is a different pattern (async handoff via shared file), not a team. |
| **Resumable Agent**                            | Codex's subagent threads can be resumed via `/agent` switching — but Gemini doesn't, with no resume and no mid-execution input. Use **Cold-Open Refinement** for the portable substitute: same multi-turn UX, no in-worker state, higher token cost.                                                |

---

## Quick checklist

```
Direct               ── inline in the assistant's turn; no worker
Trampoline           ── skill's only job is to launch a worker; phrase intent, not the call
Cold-Open Refinement ── stateless multi-turn iteration; each turn replays prior context
Parallel Agents      ── N specialists, same input, merge perspectives (Gemini: read-only safe, write risks races)
Parent Fan-Out       ── parent fans out across N targets; workers never recurse
Stamped Results      ── every worker reply tags itself with the input it processed
Action Dispatch      ── numbered menu in the report; case-insensitive single-letter keys
Prompt Intercept     ── hook handles the slash command; three envelopes per host
Adapter Hook         ── detect host via Before/After + PLUGIN_ROOT; emit the right envelope
Cut                  ── Team · Resumable Agent — Claude-only primitives, no portable substitute
```
