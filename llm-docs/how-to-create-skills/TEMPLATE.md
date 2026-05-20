# Skill template

Fillable skeleton for a new skill. Inside a plugin all three hosts read the same path; standalone install paths diverge.
Only `name` and `description` port unchanged across hosts. Cross-host details in
[CLAUDE_CODEX_GEMINI.md](../CLAUDE_CODEX_GEMINI.md).

______________________________________________________________________

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

______________________________________________________________________

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

______________________________________________________________________

## The portable SKILL.md

Drop this into `<plugin>/skills/<name>/SKILL.md`. Loads on all three hosts; the body teaches the model what to do.

```markdown
---
name: <plugin>-<verb-of-intent>
description: |
  <One-sentence purpose.> Trigger when the user <signal phrase>:
  '<example phrase>', '<another phrase>', or the slash command
  `/<plugin>-<verb>`. Use for <scope>. Do NOT trigger for <near-miss>.
---

# <Skill title>

<One-sentence framing.>

## When to use
- <Signal 1 — concrete user phrase or repo state>.
- <Signal 2>.
- <Signal 3>.

## When NOT to use
- <Near-miss A — which skill or tool wins instead>.
- <Near-miss B>.

## How to run
1. <First concrete step — read this file, run that command>.
2. <Second step — produce this artifact>.
3. <Third step — verify, report>.

## What to return
<Exact output shape: format, sections, length budget. See [BEST_PRACTICES.md — Reply shape](BEST_PRACTICES.md#reply-shape).>

## Examples
<One worked example: input phrase → action → output.>
```

Six sections, same order every time: purpose · when · when NOT · how · return · example. Cut every sentence that doesn't
shape one of those six.

______________________________________________________________________

## Description anatomy

The description is the matcher (Claude / Codex) and the human label (Gemini). One field, three roles. Build it in this
order:

```yaml
# Avoid — vague, no trigger, no exclusion
description: A helpful skill for git stuff.

# Prefer — trigger first, scope next, exclusion last
description: |
  Inspect and report on the working tree's git status with a cyberpunk
  HUD. Trigger when the user says 'show status', 'what's changed',
  'git status with style', or runs `/git-hud`. Use for read-only status
  inspection. Do NOT trigger for commits, branches, or remote ops.
```

| Slot       | What goes here                                        |
| ---------- | ----------------------------------------------------- |
| Trigger    | The user phrases or repo states that should fire this |
| Scope      | What this skill covers — one verb                     |
| Exclusion  | The near-neighbor skill that should win in some cases |
| Slash form | The `/<name>` command, if user-invocable              |

A parent LLM weighs the opening tokens hardest. A user scanning autocomplete reads the first line. Front-load.

______________________________________________________________________

## Claude-only sugar — and the portable substitute

Several conveniences only run on Claude. Reaching for them forks the skill or silently no-ops on Codex / Gemini.

| Claude sugar                   | What it does                              | Portable substitute                                                    |
| ------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------- |
| `` !`<cmd>` `` (preload)       | Runs command, inlines output              | Step-1 in the body: "Run `<cmd>` and parse the output."                |
| ```` ```! ```` (preload block) | Same, for multi-line scripts              | Explicit body step; write intermediate output to `${TMPDIR}`           |
| `$ARGUMENTS`, `$N`, `$name`    | Slash-command arg substitution            | Tell the assistant to read positional args from the prompt             |
| `${CLAUDE_SKILL_DIR}`          | Path to the skill folder                  | `Path(__file__).resolve().parent` from a sidecar script                |
| `allowed-tools:`               | Per-skill tool allowlist                  | Phrase the body to use only the tools you want                         |
| `disable-model-invocation`     | Hide from auto-invocation                 | Strong exclusion in description; ship as slash command only            |
| `paths:`                       | Auto-activate when matching files touched | Trigger via description phrase + slash-command companion               |
| `hooks:` in frontmatter        | Skill-scoped hooks                        | Promote to manifest-level `hooks` block in each host's plugin manifest |
| `argument-hint:`               | Slash-command arg autocomplete            | Spell out args in the description's example line                       |

The portable substitute is almost always "instruct the model in the body" — what Claude does via frontmatter, the body
does via prose.

______________________________________________________________________

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
description: <Mirrors the SKILL.md description.>
---

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

______________________________________________________________________

## Where artifacts go

Skills that write files need a path that resolves on all three hosts. No env var works everywhere — Claude has
`${CLAUDE_PROJECT_DIR}`, Gemini has `${GEMINI_PROJECT_DIR}`, Codex has neither. Compute the root in the body:

```markdown
## Step 0 — Locate the project root

Run `git rev-parse --show-toplevel` and bind the result to `${ROOT}`.
Write artifacts to `${ROOT}/.preemdeck/<skill>/<verb>.<ext>`.
If the cwd is not in a git repo, fall back to `${TMPDIR}/preemdeck/<skill>/`.
```

Sidecar scripts can self-locate with `Path(__file__).resolve().parents[N]`. Use the placeholder only where you have no
other option — typically inside hook config strings.

______________________________________________________________________

## Quick checklist

```
Path          ── <plugin>/skills/<name>/SKILL.md unified inside a plugin; standalone forks per host
Frontmatter   ── only name + description universal; rest is Claude-only
Description   ── trigger first, scope next, exclusion last
Body          ── purpose · when · when NOT · how · return · example
Sugar         ── !`cmd`, $ARGUMENTS, ${CLAUDE_SKILL_DIR}, allowed-tools — all Claude-only
Slash form    ── md on Claude/Codex; TOML on Gemini — ship both
Artifacts     ── compute root via `git rev-parse --show-toplevel`; no env var ports
Naming        ── <plugin>-<verb>; skill names are not namespaced on Claude/Codex
```
