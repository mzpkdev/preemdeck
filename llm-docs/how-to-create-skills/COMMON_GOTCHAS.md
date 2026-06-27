# Common gotchas

Skills look identical on paper, then bite in production. Most pain comes from Claude-only frontmatter and sugar that
silently drops on Codex / Gemini.

---

## Only `name` + `description` port

Every other frontmatter field is Claude-only. Codex and Gemini parse the YAML but ignore unknown keys — no error, no
warning.

```yaml
# Looks portable — every field except name/description silently drops on Codex/Gemini
---
name: payments-review
description: Review the staged diff for amount-overflow.
model: opus # Claude only
allowed-tools: [Read, Grep] # Claude only
when_to_use: "Before payment merge." # Claude only
disable-model-invocation: true # Claude only
paths: ["src/payments/**/*.ts"] # Claude only
hooks: { PreToolUse: [...] } # Claude only
---
```

A field that "doesn't seem to be doing anything on Gemini" is almost always a Claude-only field. Full table in
[CLAUDE_CODEX_GEMINI.md](../CLAUDE_CODEX_GEMINI.md#skillmd-frontmatter); the universal subset is _just_ `name` +
`description`.

---

## `allowed-tools:` is Claude-only

Tool restriction lives in different places per host. A skill that "shouldn't be able to write" on Claude needs
`allowed-tools:`. The same restriction on Codex / Gemini lives elsewhere — and a missing restriction is silent.

| Host   | Where to restrict                                        | Failure mode if forgotten |
| ------ | -------------------------------------------------------- | ------------------------- |
| Claude | `allowed-tools:` in SKILL.md frontmatter                 | full session scope        |
| Codex  | per-worker `sandbox_mode`; no per-skill toggle           | full session scope        |
| Gemini | extension-wide `excludeTools` in `gemini-extension.json` | full extension scope      |

Cross-host fallback: phrase the body so the model has no reason to reach for `Write` in the first place. Add host-native
scoping as defense in depth.

---

## `disable-model-invocation` toggle differs

The mechanism for "don't auto-invoke" diverges. Same intent, three implementations.

```yaml
# Claude — SKILL.md frontmatter
---
disable-model-invocation: true
---
```

```yaml
# Codex — sibling agents/openai.yaml inside the skill folder
policy:
  allow_implicit_invocation: false
```

```yaml
# Gemini — no toggle; rely on description prose
---
description: "Manual deploy. NEVER trigger automatically; only on user-typed /deploy."
---
```

Copy-pasting `disable-model-invocation: true` into a Codex / Gemini SKILL.md parses and ignores it. The skill stays
auto-invocable on those hosts.

---

## `paths:` auto-activation is Claude-only

The `paths:` glob that fires a skill when the user touches matching files is Claude-only. Codex and Gemini have no
path-based activation — they only match on description.

```yaml
# Claude — auto-activates when user touches matching files
---
paths: ["src/payments/**/*.ts", "src/billing/**/*.ts"]
---
```

```yaml
# Cross-host — match the user phrasing, not the file path
---
description: |
  Review payment-handling code in src/payments/ or src/billing/.
  Trigger when the user mentions payment code, money handling,
  or runs `/payments-review`.
---
```

The cross-host substitute: bake file-path phrases into the description so the user-prompt match still fires.

---

## Preload sugar is Claude-only

Inline command execution via `` !`<cmd>` `` or ` ```! ` runs only on Claude. On Codex / Gemini it parses as literal text
— the command never runs.

```markdown
# Avoid — Claude-only sugar, silent on Codex/Gemini

## Preload

!`"$HOME/.preemdeck/preemdeck-runtime" ${CLAUDE_PLUGIN_ROOT}/scripts/gather.ts`

# Prefer — explicit body step, runs everywhere

## Step 1 — Gather

Run `"$HOME/.preemdeck/preemdeck-runtime" ${CLAUDE_PLUGIN_ROOT}/scripts/gather.ts` and parse the JSON output. The script
self-locates if `${CLAUDE_PLUGIN_ROOT}` is unset.
```

A skill that depends on preload sugar has a runtime gap on two hosts. The model reads the body and never executes the
command.

---

## Placeholders mostly don't port

Placeholder variables differ per host. None work on all three. Reaching for them forks the skill.

| Variable                    | Claude | Codex                       | Gemini                                              |
| --------------------------- | ------ | --------------------------- | --------------------------------------------------- |
| `$ARGUMENTS`, `$N`, `$name` | yes    | —                           | —                                                   |
| `${CLAUDE_SKILL_DIR}`       | yes    | —                           | —                                                   |
| `${CLAUDE_SESSION_ID}`      | yes    | —                           | env var `GEMINI_SESSION_ID` (shell expansion only)  |
| `${CLAUDE_PLUGIN_ROOT}`     | yes    | aliased to `${PLUGIN_ROOT}` | —                                                   |
| `${CLAUDE_PROJECT_DIR}`     | yes    | —                           | env var `GEMINI_PROJECT_DIR` (shell expansion only) |
| `${extensionPath}`          | —      | —                           | yes — manifest placeholder, host-substituted        |

Two systems on Gemini, easy to confuse. **`${extensionPath}`** (plus `${workspacePath}` and `${/}`) are _manifest
placeholders_ the host substitutes before launching the process. The `GEMINI_*` names are _env vars_ exposed to the
spawned process — they resolve via shell `${VAR}` expansion inside a hook `command` string but **don't** get substituted
in arbitrary `gemini-extension.json` fields. Cross-host portable: compute paths inside the body via shell
(`git rev-parse --show-toplevel`) or in a sidecar script (`Path(__file__).resolve().parents[N]`). Reach for a
placeholder only where you have no other option — typically the `command` field in a hook config.

---

## The `Skill` tool is Claude-only

Skill-to-skill invocation via the `Skill` tool exists only on Claude. A SKILL.md that says "use the Skill tool to invoke
`/other-skill`" silently fails on Codex / Gemini.

```markdown
# Avoid — Claude-only

"Use the Skill tool to invoke the `git-status-hud` skill."

# Prefer — describe the intent; the model handles host-appropriate hand-off

"For the status surface, run the equivalent of the `git-status-hud` skill:

1. `git status --porcelain=v2 -z`
2. Format with the HUD rules in <link>"
```

Cross-host plugins keep skills atomic — no programmatic chaining between them. Pull shared logic into a companion file
both skills include in their body.

---

## Slash-command formats diverge

A user-invocable `/<name>` needs a Markdown file on Claude / Codex _and_ a TOML file on Gemini. Shipping only one host's
format silently drops the others.

```
# Avoid — only Markdown ships; Gemini sees no slash command
<plugin>/
└── commands/
    └── deploy.md

# Prefer — both formats, same intent
<plugin>/
├── commands/
│   ├── deploy.md                ── Claude (and Codex, where commands are deprecated)
│   └── deploy.toml              ── Gemini
└── skills/
    └── deploy/
        └── SKILL.md
```

Update both command files when the skill body changes — no validator catches drift.

---

## Hard-coded `Agent(…)` in the body

A SKILL.md that says `Agent({ subagent_type: "reviewer", … })` works on Claude, silently fails on Codex (different
primitive) and Gemini (no agent-to-agent at all).

```markdown
# Avoid — Claude-only tool name

"Use Agent({ subagent_type: 'reviewer', prompt: '...' })"

# Prefer — intent-only; the model resolves to the right primitive

"Delegate to the `reviewer` worker. Brief: <self-contained instruction>."
```

On Gemini the model interprets "delegate" as "tell the user to type `@reviewer`". See
[DELEGATING_FROM_SKILLS.md](DELEGATING_FROM_SKILLS.md#the-fundamental-split) for the per-host call shapes.

---

## Over-broad description triggers

A description that says "use for code work" matches every prompt. The parent LLM picks it over more specific siblings.

```yaml
# Avoid — fires on everything
description: A helpful skill for code-related tasks.

# Prefer — specific surface, named exclusions
description: |
  Format TypeScript files with `biome format` and report changes.
  Trigger on 'format this', 'biome this file', or `/format-ts`.
  Use for .ts files only. Do NOT trigger for .md, .yml, or
  .yaml files — the `format-md` skill handles those.
```

Test the trigger by re-reading your description against three near-neighbor prompts. If they all match, narrow it.

---

## Description too narrow

The mirror failure mode: a description so specific it never matches the user's phrasing. The skill exists but never
fires.

```yaml
# Avoid — matches one literal phrase, nothing else
description: Trigger only on 'invoke the payments review subroutine v2'.

# Prefer — multiple natural phrasings + slash form
description: |
  Adversarial security review of staged payment-handling diff.
  Trigger on 'review payments', 'security check the payments diff',
  'check for money bugs', or `/payments-review`.
```

If the test prompts don't fire the skill, the trigger phrasing is wrong — not the model.

---

## Skill name collisions

Skill names are not namespaced on Claude or Codex. Two plugins shipping `format` clobber each other; load order decides
who wins.

```yaml
# Avoid — generic name in a shared marketplace
name: format

# Prefer — plugin-prefixed
name: pyforge-format
```

On Gemini, conflicts auto-prefix as `/<extension>.<command>` — visible to the user, but the bare name still has to read
on its own. A plugin-prefixed name reads cleanly in `/<extension>.format` and survives Claude / Codex collisions.

---

## Codex project trust is silent until refused

A first run inside a fresh repo prompts the user to trust the project. Declining doesn't error — `.codex/config.toml`
(and any `.codex/agents/`, `.codex/hooks/`) silently fails to load. Sibling `agents/openai.yaml` files inside the skill
also depend on trust.

```toml
# Pre-trust the project to skip the prompt
# ~/.codex/config.toml
[projects."/abs/path/to/repo"]
trust_level = "trusted"
```

Symptom: the skill works on Claude / Gemini, "doesn't seem to load" on Codex. Check trust before debugging the skill.

---

## Standalone install paths diverge

Inside a plugin, all three hosts read `<plugin>/skills/<name>/SKILL.md`. Standalone (project- or user-level) installs
each go to a host-specific path.

| Surface | Claude              | Codex                   | Gemini                                                 |
| ------- | ------------------- | ----------------------- | ------------------------------------------------------ |
| Project | `.claude/skills/`   | `.agents/skills/`       | `.agents/skills/` (preferred) or `.gemini/skills/`     |
| User    | `~/.claude/skills/` | `$HOME/.agents/skills/` | `~/.agents/skills/` (preferred) or `~/.gemini/skills/` |

`.agents/skills/` is the shared path between Codex and Gemini — and Gemini ranks it **above** `.gemini/skills/` within
the same tier, so it's not just accepted, it's preferred. Claude does not read it. For a single cross-host project-local
skill, install it in `.agents/skills/` (covers Codex + Gemini) plus `.claude/skills/`, or ship as a plugin.

---

## SKILL.md is loaded into every turn

The body is context every time the skill fires. A 600-line SKILL.md eats prompt budget on every turn the skill matches —
including turns where the model decides not to act on it.

```markdown
# Avoid — everything inline; the body loads even when the skill won't use it

## How to run

[full schema, full examples, full error catalog — 600 lines]

# Prefer — concise body, link out for depth

## How to run

1. Validate against `<skill>/SCHEMA.md`.
2. Render via `<skill>/EXAMPLES.md`.
3. On error, see `<skill>/ERRORS.md`.
```

Aim for SKILL.md under 200 lines. Past 300 it stops being a skill and becomes a small library — split it or move detail
into companion files the model loads on demand.

---

## "Based on prior turns…" assumptions

The skill body is the only context the model gets _about the skill_. Phrases like "based on the previous step" or "as
discussed earlier" lean on conversation history the model may not have when the skill fires.

```markdown
# Avoid — leans on prior conversation

## Step 2 — Apply the fix discussed.

# Prefer — self-contained

## Step 2 — Apply the fix

Edit `src/payments.ts:42` to return a `bigint` of minor units instead of a `float`. Keep the function signature.
```

A skill is loaded mid-turn. The body must stand on its own.

---

## Quick checklist

```
Frontmatter     ── only name + description port; rest is Claude-only
allowed-tools   ── Claude-only; use sandbox_mode (Codex) / excludeTools (Gemini)
disable-invoke  ── Claude frontmatter · Codex sibling yaml · Gemini description prose
paths:          ── Claude-only auto-activation; move into description on Codex/Gemini
Preload sugar   ── !`cmd` is Claude-only; promote to a body step elsewhere
Placeholders    ── $ARGUMENTS · ${CLAUDE_SKILL_DIR} are Claude-only; compute at runtime
Skill tool      ── Claude-only; cross-host skills don't programmatically chain
Slash commands  ── md on Claude/Codex; TOML on Gemini — ship both
Agent(...)      ── Claude-only literal; phrase intent instead
Triggers        ── narrow + exclude; test against three near-neighbor prompts
Too narrow      ── multiple phrasings + slash form; one literal phrase is brittle
Name collisions ── plugin-prefix; no namespacing on Claude/Codex
Codex trust     ── silent failure if project not trusted
Install paths   ── plugin path unified; standalone paths diverge per host
Body size       ── keep under 200 lines; offload depth to companion files
Cold open       ── no "as discussed earlier"; the body stands alone
```
