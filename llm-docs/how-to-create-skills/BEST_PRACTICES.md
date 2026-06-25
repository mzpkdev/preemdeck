# Best practices

Patterns that produce reliable, discoverable skills across Claude, Codex, and Gemini. A skill loads cold — the model
reads it mid-turn and acts. Brief it like a colleague who walked in late.

---

## Single responsibility

One skill, one job. If the description needs two "and"s, split the skill.

```yaml
# Avoid — three jobs jammed into one
name: helper
description: Reviews diffs, runs tests, and drafts PR descriptions.

# Prefer — one verb per skill
name: payments-review
description: Adversarial security review of the staged diff. Returns numbered findings.
```

The parent LLM picks a skill by string-matching `description`. Overloaded descriptions match too eagerly and confuse
selection on every host.

---

## Naming

Verb-of-intent. Kebab-case. Prefix with the plugin. The name shows up in error messages on Claude / Codex and in
`/<extension>.<name>` autoprefix on Gemini.

| Good              | Why                       |
| ----------------- | ------------------------- |
| `git-status-hud`  | clear scope               |
| `payments-review` | plugin-prefixed           |
| `lint-pyfile`     | one verb                  |
| `secrets-scan`    | plugin-prefixed, one verb |

| Avoid           | Why                                          |
| --------------- | -------------------------------------------- |
| `helper`        | nothing concrete                             |
| `do-stuff`      | unmatchable by description                   |
| `git-status-v2` | version in name breaks rename safety         |
| `reviewer`      | collides with worker names and other plugins |

Skill names are not namespaced on Claude or Codex. Two plugins shipping `format` clobber each other; load order decides
who wins. On Gemini, conflicts auto-prefix as `/<extension>.<name>` — but the bare name still has to read on its own.

---

## Description triggers

The description is the matcher (Claude / Codex) and the user-facing label (Gemini). Front-load the trigger phrase, name
the scope, declare exclusions.

```yaml
# Avoid — vague, useless to both LLMs and humans
description: A helpful skill for git work.

# Prefer — trigger first, scope next, exclusion last
description: |
  Inspect and report on the working tree's git status with a cyberpunk HUD.
  Trigger when the user says 'show status', 'what's changed', 'git status
  with style', or runs `/git-hud`. Use for read-only status inspection.
  Do NOT trigger for commits, branches, or remote ops.
```

Three rules that compound:

- **Trigger first** — the matcher reads opening tokens hardest.
- **Concrete phrases** — `'show status'` beats `requests for status`.
- **Explicit NOT** — name the near-neighbor skill that should win.

Hedging like "may help with…" or "useful for…" loses to a sibling skill that says "Trigger when…".

---

## Progressive disclosure

`SKILL.md` lands in the model's context every time the skill fires. Keep the body lean. Reference companion files for
bulk.

```markdown
# Avoid — 400-line SKILL.md with everything inline

## How to run

First, here's the full spec of the JSON schema we use… [200 lines] Then the worked example… [80 lines] Then the error
catalog… [120 lines]

# Prefer — concise body, link out for depth

## How to run

1. Validate input against `<skill>/SCHEMA.md`.
2. Render output following `<skill>/EXAMPLES.md`.
3. On error, consult `<skill>/ERRORS.md` and pick the matching template.
```

Companion files (`SCHEMA.md`, `EXAMPLES.md`, `ERRORS.md`) live next to `SKILL.md`. The body teaches the model _what to
load when_; the model fetches the rest only on demand.

Aim for SKILL.md under 200 lines. Past 300 it stops being a skill and becomes a small library.

---

## Tool scoping

The mechanism differs per host; keep the intent the same. A skill that "reads files" should never gain `Write`.

| Host   | Where scope lives                                         |
| ------ | --------------------------------------------------------- |
| Claude | per-skill `allowed-tools:` frontmatter                    |
| Codex  | per-worker `sandbox_mode` on workers; no per-skill toggle |
| Gemini | extension-level `excludeTools` in `gemini-extension.json` |

```yaml
# Claude — per-skill allowlist
allowed-tools: [Read, Grep, Glob, Bash(git status:*)]
```

```jsonc
// Gemini — extension-wide deny
{ "excludeTools": ["Write", "Edit", "MultiEdit"] }
```

For a cross-host skill, do the work at the _call layer_: phrase the body so the model has no reason to reach for `Write`
in the first place. Add Claude / Gemini scoping as defense in depth.

---

## Model selection

Match the model to the task. Heavier models are slower and more expensive. Don't default to the most capable tier.

| Task shape                    | Claude (`model:`) | Codex               | Gemini (worker only) |
| ----------------------------- | ----------------- | ------------------- | -------------------- |
| Quick lookup, regex, format   | haiku             | gpt-5.4-mini        | gemini-2.5-flash     |
| Mid-depth review, simple plan | sonnet            | gpt-5.3-codex       | gemini-2.5-pro       |
| Adversarial review, hard plan | opus              | gpt-5.3-codex-spark | gemini-2.5-pro       |

Only Claude reads `model:` from SKILL.md frontmatter. On Codex and Gemini the model is the host's session default unless
you delegate to a worker (which declares its own model).

---

## Manual invocation

If the skill should also fire on `/<name>`, ship a slash-command sibling. The format diverges — Markdown on Claude /
Codex, **TOML** on Gemini.

```
<plugin>/
├── skills/<name>/SKILL.md            ── auto-invocation everywhere
├── commands/<name>.md                ── slash form (Claude / Codex)
└── commands/<name>.toml              ── slash form (Gemini)
```

The two command files hand off to the same skill — don't duplicate the logic:

```markdown
# commands/<name>.md (Claude / Codex)

---

## description: <Mirrors the SKILL.md description.>

Invoke the `<name>` skill against the current working tree.
```

```toml
# commands/<name>.toml (Gemini)
description = "<Mirrors the SKILL.md description.>"
prompt = "Invoke the <name> skill against the current working tree."
```

Update both command files when the skill body changes. Drift is silent — no validator catches it.

---

## Reproducibility

A skill is a contract: same input, same output. Keep the body deterministic.

```markdown
# Avoid — leans on model judgment for paths

"Find the relevant files and report on them."

# Prefer — concrete commands, deterministic order

"Run `git status --porcelain=v2 -z`. Parse the result with the rules in PARSING.md. Report in the order the porcelain
emits them."
```

Things that drift:

- Asking the model to "decide what's relevant"
- Free-form output shapes ("write a summary")
- File paths embedded in prose ("the source directory")

Things that stick:

- Shell commands with explicit flags
- Output shapes declared as schemas
- Paths via `git rev-parse --show-toplevel` or `__file__`

---

## Briefing the model

The skill body is the brief. The model has no memory of how the skill came to be loaded — only the user's last turn and
whatever the body contains.

```markdown
# Avoid — leans on hidden parent context

"Now do the status check."

# Prefer — self-contained instruction

"Read the porcelain output from step 1. For each unstaged file, emit a line `<state> <path>` where state is one of
M/A/D/R/U. Sort by path."
```

Include the task, the inputs (paths, not pasted content), the output shape. Cut every sentence that doesn't shape one of
those three.

---

## Reply shape

A skill runs in the assistant's turn — the assistant's reply _is_ the output. Declare the shape in the body so every
invocation produces the same thing.

| Shape               | Use when                                            |
| ------------------- | --------------------------------------------------- |
| Single-line verdict | Boolean question — `OK.` / `FAIL: <why>`            |
| Markdown report     | Default — human reads it directly                   |
| Structured JSON     | The reply will be parsed by another skill or script |

Default to markdown for users; JSON only when a parser is on the other side; one-liner for guards.

| Reply type      | Budget                  |
| --------------- | ----------------------- |
| Verdict only    | one line                |
| Markdown report | one screen (≈ 40 lines) |
| Findings list   | ten items, twenty max   |

A 200-line skill reply is almost always a 10-line reply with prose around it. Cap inline output; link the artifact path
(`${ROOT}/.preemdeck/<skill>/<verb>.<ext>`) for the full body. The artifact is the truth; the reply is the index.

---

## Graceful failure

A skill that can't do its job must say what failed and how to fix it. Silent "Done." replies leave the user re-running
commands manually and the parent LLM with no signal to retry intelligently.

```markdown
# Avoid — silent failure looks like success

"Done." # but the artifact was never written

# Prefer — name the failure and the fix

"FAIL: cwd is not a git repo. Re-run from inside the project root, or pass `--root <path>` explicitly."
```

Three principles:

- **Name the cause** — "file not found", "command exited 2", "merge in progress".
- **Name the fix** — what the user does next.
- **Never lie** — if step 2 failed, step 3's output is suspect; say so.

On failure, hold the reply contract — same sections, verdict flipped to `FAIL: <cause>`. The user (or downstream parser)
needs to read failure the same way as success.

---

## Verify, don't trust

Skills that report on state should re-read state before reporting. Models hallucinate convincingly when the underlying
surface drifts.

```markdown
# Avoid — assumes prior step's output is still accurate

"Use the file list from before."

# Prefer — re-fetch the surface every time

"Re-run `git status --porcelain=v2 -z` to refresh the surface, then…"
```

Same rule for skills that mutate state: re-read after writing, confirm the diff matches intent. The harness will not
catch a no-op write that the model claims succeeded.

---

## Workers — cross-link

A skill can delegate to a worker (subagent). Two flavors:

- **Registered worker** — file-per-host with a stable persona, model override, and tool scope. Claude + Gemini ship it
  bundled in the plugin; Codex needs the file at user or project tier (plugins can't bundle subagents). See
  [DELEGATING_FROM_SKILLS.md — Where the worker file lives](DELEGATING_FROM_SKILLS.md#where-the-worker-file-lives).
- **Generic worker (inline brief)** — persona lives in the brief, not in a file. Claude has `general-purpose` built-in,
  Codex has `worker` built-in, Gemini needs a one-time 10-line shim at `<plugin>/agents/worker.md`. See
  [DELEGATING_FROM_SKILLS.md — Generic worker](DELEGATING_FROM_SKILLS.md#generic-worker--inline-brief-no-registered-persona).

Registered-worker paths:

```
Claude  ── <plugin>/agents/<worker>.md                          (md + YAML)
Codex   ── ~/.codex/agents/<worker>.toml or .codex/agents/...   (TOML; not plugin-bundleable — ship in assets/ and copy at SessionStart)
Gemini  ── <plugin>/agents/<worker>.md                          (md + YAML)
```

The Gemini caveat: a skill cannot programmatically call a worker. Phrase the skill body as intent ("delegate to
`<worker>`") — Claude and Codex models fire the call; Gemini interprets the same line as "tell the user to type
`@worker`". Never hard-code a host primitive.

---

## Quick checklist

```
Responsibility ── one verb per skill; two "and"s means split it
Naming         ── kebab-case, plugin-prefixed; no version suffixes
Description    ── trigger first, scope next, exclusion last
Disclosure     ── SKILL.md under 200 lines; companion files for depth
Tool scope     ── Claude allowed-tools · Gemini excludeTools · phrase the body
Model          ── match to task; only Claude reads frontmatter `model:`
Manual form    ── ship md + toml commands sibling if user-invocable
Reproducibility── shell commands + schemas, not prose + judgment
Briefing       ── self-contained; paths, not pasted content
Failure        ── name the cause + fix; never reply "Done." on failure
Verify         ── re-read state before reporting; trust nothing
Workers        ── Gemini can't programmatically call them — design user-facing
```
