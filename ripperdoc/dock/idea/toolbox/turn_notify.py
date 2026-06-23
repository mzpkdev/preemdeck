#!/usr/bin/env python3
"""Turn-end balloon for the running JetBrains IDE, tagged with the firing session.

The Stop / AfterAgent hook entrypoint across the three hosts. Where notify.py pops
a fixed string ("Claude finished responding"), this derives a per-tab identity so a
developer juggling many concurrent agent tabs can tell at a glance WHICH session
just yielded:

    title:  <project> · <branch>
    body:   <one-line gist of the agent's last message>

All three hosts hand the just-finished reply text straight to the hook in its stdin
payload, so there is no transcript to parse: Claude's Stop and Codex's Stop carry
`last_assistant_message`, Gemini's AfterAgent carries `prompt_response`. `<project>`
is the basename of the payload `cwd`; `<branch>` is read live with a short
`git rev-parse` in that cwd, since no host hands a turn-end hook the current branch.
The host label (argv[0], e.g. "Claude") heads the title when no cwd is known and is
the fallback body ("<host> finished responding") when no gist is available — a
tool-only final turn (the reply field is optional) or an empty/foreign payload.

Best-effort and SILENT by contract: a missing IDE, absent/foreign stdin, or a git
failure yields a graceful fallback (or no balloon) and ALWAYS exits 0 — a turn-end
hook must never surface an error or block the host. Dynamic text is HTML-escaped
before it reaches the balloon, since IDE notifications render HTML.
"""

import html
import json
import os
import re
import subprocess
import sys

from core import in_idea
from notify import notify

# Body cap: a couple of wrapped balloon lines. Longer gists truncate on a word
# boundary with an ellipsis.
GIST_MAX = 140

_MD = re.compile(r"[*_`]+")  # inline emphasis / code ticks
_LINK = re.compile(r"\[([^\]]+)\]\([^)]+\)")  # [text](url) -> text
_WS = re.compile(r"\s+")


def _read_hook_input() -> dict:
    """Parse the hook's stdin payload as JSON; {} on anything unexpected.

    Guards `isatty()` so a host that leaves stdin attached to the terminal (rather
    than piping a payload) never blocks the read.
    """
    try:
        if sys.stdin.isatty():
            return {}
        raw = sys.stdin.read()
    except Exception:
        return {}
    try:
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _clean_gist(text: str) -> str:
    """First meaningful line of `text`, markdown stripped, truncated to GIST_MAX.

    Skips leading blockquote (`>` — the imprint's `Re:` headers) and heading (`#`)
    lines so the gist lands on the actual answer line, strips inline markdown and
    link syntax, collapses whitespace, then truncates on a word boundary with an
    ellipsis.
    """
    line = ""
    for raw in text.strip().splitlines():
        candidate = raw.strip()
        if not candidate or candidate[0] in ">#":
            continue
        line = candidate
        break
    if not line:
        line = text.strip()
    line = _LINK.sub(r"\1", line)
    line = _MD.sub("", line)
    line = _WS.sub(" ", line).strip(" -•\t")
    if len(line) > GIST_MAX:
        line = line[:GIST_MAX].rsplit(" ", 1)[0].rstrip() + "…"
    return line


def _payload_gist(data: dict) -> str | None:
    """The current turn's reply text taken straight from the hook payload, cleaned.

    Every host puts the just-finished reply in its stdin payload: Claude's Stop and
    Codex's Stop as `last_assistant_message`, Gemini's AfterAgent as
    `prompt_response` — all already flushed, so no transcript read is needed. None
    for an absent/blank field (the field is optional — e.g. a tool-only final turn)
    or Gemini's "[no response text]" sentinel, so the caller falls back to the host
    label.
    """
    raw = data.get("last_assistant_message") or data.get("prompt_response")
    if not isinstance(raw, str) or not raw.strip() or raw.strip() == "[no response text]":
        return None
    return _clean_gist(raw) or None


def _git_branch(cwd: str | None) -> str | None:
    """Current git branch in `cwd` via `git rev-parse --abbrev-ref HEAD`, or None.

    No host hands the current branch to a turn-end hook, so it's read live here.
    Best-effort: None with no `cwd`, outside a repo, in detached HEAD (`git` prints
    "HEAD"), or on any spawn error/timeout — never raises, so a turn-end hook stays
    silent. The short timeout keeps it well inside the host's 5s hook budget.
    """
    if not cwd:
        return None
    try:
        out = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    branch = out.stdout.strip()
    if out.returncode != 0 or not branch or branch == "HEAD":
        return None
    return branch


def _title(host: str, cwd: str | None, branch: str | None) -> str:
    """`<project> · <branch>` — project from cwd basename, host label as fallback head."""
    project = os.path.basename(cwd.rstrip("/")) if cwd else ""
    head = project or host
    return f"{head} · {branch}" if branch else head


def main(argv: list[str]) -> int:
    """Pop the turn-end balloon for the firing session; never raise, always exit 0.

    argv[0] is the host label (e.g. "Claude") — it heads the title when no cwd is
    known and is the fallback body when the payload carries no reply text.
    """
    host = argv[0] if argv else "Agent"
    try:
        if not in_idea():
            return 0  # not inside a JetBrains IDE: nothing to pop, and no error
        data = _read_hook_input()
        cwd = data.get("cwd") or os.environ.get("PWD")
        gist = _payload_gist(data)
        branch = _git_branch(cwd)
        title = _title(host, cwd, branch)
        body = gist or f"{host} finished responding"
        notify(html.escape(body), title=html.escape(title))
    except Exception:
        pass  # best-effort: a turn-end hook must never error or block the host
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
