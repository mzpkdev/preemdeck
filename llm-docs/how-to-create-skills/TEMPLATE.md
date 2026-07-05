# Skill template

Fillable skeleton for a new skill. Inside a plugin all three hosts read the same path; standalone install paths diverge.
Only `name` and `description` port unchanged across hosts. Cross-host details in
[CLAUDE_CODEX_GEMINI.md](../CLAUDE_CODEX_GEMINI.md).

---

## Where the file lives

A plugin-shipped skill has one path. Project- and user-level installs are host-specific by design — `.agents/skills/` is
the shared path for Codex and Gemini (Gemini ranks it **above** `.gemini/skills/` within the same tier). Claude does not
read it.

| Surface         | Claude                             | Codex                                  | Gemini                                                                               |
| --------------- | ---------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| Inside a plugin | `<plugin>/skills/<name>/SKILL.md`  | same path                              | same path                                                                            |
| Project-local   | `.claude/skills/<name>/SKILL.md`   | `.agents/skills/<name>/SKILL.md`       | `.agents/skills/<name>/SKILL.md` (preferred) or `.gemini/skills/<name>/SKILL.md`     |
| User-level      | `~/.claude/skills/<name>/SKILL.md` | `$HOME/.agents/skills/<name>/SKILL.md` | `~/.agents/skills/<name>/SKILL.md` (preferred) or `~/.gemini/skills/<name>/SKILL.md` |

Ship inside a plugin if you want one path. A standalone skill installs three times.

---

## Frontmatter — what ports

Two fields universal. Everything else is Claude-only and silently drops on Codex / Gemini.

| Field                         | Claude | Codex                                 | Gemini |
| ----------------------------- | ------ | ------------------------------------- | ------ |
| `name`                        | yes    | yes                                   | yes    |
| `description`                 | yes    | yes                                   | yes    |
| `when_to_use`                 | yes    | —                                     | —      |
| `disable-model-invocation`    | yes    | sibling `agents/openai.yaml` in skill | —      |
| `user-invocable`              | yes    | —                                     | —      |
| `allowed-tools`               | yes    | —                                     | —      |
| `model`                       | yes    | —                                     | —      |
| `effort`                      | yes    | —                                     | —      |
| `argument-hint` / `arguments` | yes    | —                                     | —      |
| `paths` (auto-activate)       | yes    | —                                     | —      |
| `shell`                       | yes    | —                                     | —      |
| `hooks`                       | yes    | —                                     | —      |

Fold richer guidance into `description`; it ports everywhere. Reaching for a Claude-only field forks the SKILL.md per
host.

---

## The portable SKILL.md

Drop this into `<plugin>/skills/<name>/SKILL.md`. Loads on all three hosts; the body teaches the model what to do.

````markdown
---
name: <plugin>-<verb-of-intent>
description: |
  <User-facing purpose: one or two plain sentences, the label a human reads
  in autocomplete.> (<Trigger follow-up: '<example phrase>', '<another
  phrase>', or `/<plugin>-<verb>`. For <scope>; not <near-miss>.>)
---

# <Skill Name>

## Overview

<One or two sentences: what this skill does and when to use it.>

## Announcement

<One line the AI says when this skill activates, so the user knows it's running.>

## Prerequisites

<Dependencies / other skills / inputs required. Omit this section if none.>

- <dependency>

## Instructions

1. <First step.>
2. <Second step.>
3. <Continue as needed.>

## Template

<Markdown template the AI fills in when applying this skill.>

```
<paste template here>
```

## Examples

**Prefer:**

- <good example>

**Avoid:**

- <bad example>

## Checklist

Before ending the turn, confirm:

- [ ] <thing to verify>
- [ ] <thing to verify>

## Handoff

<What happens next: call skill X, ask the user Y, or stop here.>
````

Eight sections in fixed order: overview · announcement · prerequisites · instructions · template · examples · checklist
· handoff. Prerequisites is the only optional one — drop it when there are none. Cut every sentence that doesn't shape
one of them.

---

## Vocabulary

Every rule in the body MUST carry an RFC 2119 keyword, uppercased — semantics, level-picking litmus, and dosing rules in
[RFC_2119_KEYWORDS.md](../RFC_2119_KEYWORDS.md). The keyword holds the force, so the prose around it stays thin and
reads like code. Procedural steps stay plain imperative; keywords mark rules.

```
MUST / MUST NOT       → absolute requirement / prohibition; no exceptions
SHOULD / SHOULD NOT   → strong default; deviate only with reason
MAY                   → genuinely optional
ALWAYS / NEVER        → every case, every turn
REQUIRED / OPTIONAL   → inputs, fields, arguments
```

---

## Description anatomy

The description is the matcher (Claude / Codex) and the human label (Gemini). One field, three roles. Split it in two: a
user-facing lead, then a trigger follow-up in parens.

```yaml
# Avoid — vague, no trigger, no exclusion
description: A helpful skill for git stuff.

# Prefer — user-facing lead first, trigger follow-up in parens
description: |
  Inspect and report on the working tree's git status with a cyberpunk HUD.
  (Trigger on 'show status', 'what's changed', 'git status with style', or
  `/git-hud`. For read-only status inspection; not commits, branches, or
  remote ops.)
```

| Slot       | What goes here                                                             |
| ---------- | -------------------------------------------------------------------------- |
| Lead       | User-facing purpose — plain sentence(s), the autocomplete label; no jargon |
| Trigger    | The user phrases or repo states that should fire this                      |
| Scope      | What this skill covers — one verb                                          |
| Exclusion  | The near-neighbor skill that should win in some cases                      |
| Slash form | The `/<name>` command, if user-invocable                                   |

Lead sits before the parens; trigger, scope, exclusion, and slash form pack inside them. A parent LLM weighs the opening
tokens hardest and a user scanning autocomplete reads only the lead, so the lead must name the real thing the skill
does.

---

## Claude-only sugar — and the portable substitute

Several conveniences only run on Claude. Reaching for them forks the skill or silently no-ops on Codex / Gemini.

| Claude sugar                | What it does                              | Portable substitute                                                    |
| --------------------------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| `` !`<cmd>` `` (preload)    | Runs command, inlines output              | Step-1 in the body: "Run `<cmd>` and parse the output."                |
| ` ```! ` (preload block)    | Same, for multi-line scripts              | Explicit body step; write intermediate output to `${TMPDIR}`           |
| `$ARGUMENTS`, `$N`, `$name` | Slash-command arg substitution            | Tell the assistant to read positional args from the prompt             |
| `${CLAUDE_SKILL_DIR}`       | Path to the skill folder                  | `Path(__file__).resolve().parent` from a sidecar script                |
| `allowed-tools:`            | Per-skill tool allowlist                  | Phrase the body to use only the tools you want                         |
| `disable-model-invocation`  | Hide from auto-invocation                 | Strong exclusion in description; ship as slash command only            |
| `paths:`                    | Auto-activate when matching files touched | Trigger via description phrase + slash-command companion               |
| `hooks:` in frontmatter     | Skill-scoped hooks                        | Promote to manifest-level `hooks` block in each host's plugin manifest |
| `argument-hint:`            | Slash-command arg autocomplete            | Spell out args in the description's example line                       |

The portable substitute is almost always "instruct the model in the body" — what Claude does via frontmatter, the body
does via prose.

---

## Slash-command sibling

If the skill should also fire on `/<name>`, ship a sibling command file. The format diverges — Markdown on Claude /
Codex, **TOML** on Gemini.

```
<plugin>/
├── skills/<name>/SKILL.md            ── auto-invocation everywhere
├── commands/<name>.md                ── slash form on Claude (and Codex, where commands are deprecated in favor of skills)
└── commands/<name>.toml              ── slash form on Gemini
```

```markdown
# commands/<name>.md (Claude / Codex)

---

## description: <Mirrors the SKILL.md description.>

Invoke the `<name>` skill against the current working tree.
```

```toml
# commands/<name>.toml (Gemini)
description = "<Mirrors the SKILL.md description.>"
prompt = """
Invoke the <name> skill against the current working tree.
"""
```

Two files, same intent. Update both when the body changes; drift is silent.

---

## Where artifacts go

Skills that write files need a path that resolves on all three hosts. No env var works everywhere — Claude has
`${CLAUDE_PROJECT_DIR}`, Gemini has `${GEMINI_PROJECT_DIR}`, Codex has neither. Compute the root in the body:

```markdown
## Step 0 — Locate the project root

Run `git rev-parse --show-toplevel` and bind the result to `${ROOT}`. Write artifacts to
`${ROOT}/.preemdeck/<skill>/<verb>.<ext>`. If the cwd is not in a git repo, fall back to `${TMPDIR}/preemdeck/<skill>/`.
```

Sidecar scripts can self-locate with `Path(__file__).resolve().parents[N]`. Use the placeholder only where you have no
other option — typically inside hook config strings.

---

## Quick checklist

```
Path          ── <plugin>/skills/<name>/SKILL.md unified inside a plugin; standalone forks per host
Frontmatter   ── only name + description universal; rest is Claude-only
Description   ── user-facing lead, then trigger + scope + exclusion in parens
Body          ── overview · announcement · prerequisites · instructions · template · examples · checklist · handoff
Vocabulary    ── RFC 2119, uppercased: MUST / SHOULD / MAY / ALWAYS / NEVER / REQUIRED / OPTIONAL — see RFC_2119_KEYWORDS.md
Sugar         ── !`cmd`, $ARGUMENTS, ${CLAUDE_SKILL_DIR}, allowed-tools — all Claude-only
Slash form    ── md on Claude/Codex; TOML on Gemini — ship both
Artifacts     ── compute root via `git rev-parse --show-toplevel`; no env var ports
Naming        ── <plugin>-<verb>; skill names are not namespaced on Claude/Codex
```
