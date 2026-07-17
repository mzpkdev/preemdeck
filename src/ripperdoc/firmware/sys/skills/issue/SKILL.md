---
description: |
  File a GitHub issue on the preemdeck repo from a rough ask. You draft a clean bug or feature ticket from the
  operator's prompt plus the session context, show it, and post ONLY after they confirm — never the raw prompt
  verbatim. Trigger when the operator runs /sys:issue or asks to file/report a preemdeck bug or feature request.
  NEVER auto-invoke: it posts to a public repo.
user-invocable: true
disable-model-invocation: true
allowed-tools: [Bash]
---

# sys:issue

Turn a rough ask into a well-formed GitHub issue on preemdeck's repo (`mzpkdev/preemdeck`). The operator gives a
one-line problem or wish (`/sys:issue <fix or feature>`); you author the ticket from that plus the session context, show
it, and open it **only after they confirm**. You are the author, not a pass-through — MUST NOT post the raw prompt
as-is.

## 1. Read the ask

The text after `/sys:issue` is the seed: a bug ("X crashes when Y") or a wish ("I wish X could happen when Y"). If it is
empty, ask the operator for one line describing the problem or feature, then continue. Fold in anything relevant already
in this session — the command that failed, the error text, what they were doing.

## 2. Gather environment context

Best-effort (skip any that fail), to stamp the ticket:

```bash
git -C "$HOME/.preemdeck" describe --tags --always   # version
uname -sm                                            # OS + arch
```

Also read the `channel` from `$HOME/.preemdeck/preemdeck.json` (default `stable` if absent), and note which harness you
are running in (claude / codex / gemini).

## 3. Classify and draft

Decide **fix** (a bug or regression) or **feature** (an enhancement or request), then write:

- **Title** — one concrete line. Imperative for a fix ("statusline crashes on a detached HEAD"), a noun phrase for a
  feature ("add /sys:issue to file tickets from the CLI"). No "please", no restating "/sys:issue".
- **Body** — GitHub markdown:
  - **Summary** — one or two sentences.
  - Fix: **Steps to reproduce**, **Expected**, **Actual**. Fill from context; write "unknown" rather than invent.
  - Feature: **Motivation** (the pain) and **Proposal** (the wish, sharpened).
  - **Environment** — version, channel, harness, OS/arch from step 2.

## 4. Scrub before it goes public

A GitHub issue is public and indexed. You MUST strip, from both title and body:

- secrets, tokens, keys, `.env` values;
- absolute home paths — rewrite `/Users/<name>/…` or `/home/<name>/…` as `~/…`;
- anything identifying the operator or a private repo other than preemdeck itself.

When unsure whether something is sensitive, drop it.

## 5. Check for duplicates

```bash
gh issue list -R mzpkdev/preemdeck --state open --search "<key terms>" --limit 5
```

If one clearly covers the same thing, show it and offer to comment on it (`gh issue comment`) instead of opening a
near-duplicate.

## 6. Confirm — MANDATORY

Show the operator the exact **title**, **label** (`bug` for a fix, `enhancement` for a feature), and **body** you will
post. You MUST get an explicit yes before creating it. If they change anything, redraft and show it again. MUST NOT
create the issue without this gate.

## 7. Create and report

Write the body to a temp file and pass it, so markdown survives shell quoting:

```bash
gh issue create -R mzpkdev/preemdeck --title "<title>" --label "<bug|enhancement>" --body-file <file>
```

If the label does not exist on the repo, `gh` errors — retry once without `--label`. Print the returned issue URL.

If `gh` is missing or `gh auth status` fails, say so and point the operator to `gh auth login` (it needs issue-write on
`mzpkdev/preemdeck`); do not attempt any other path.
