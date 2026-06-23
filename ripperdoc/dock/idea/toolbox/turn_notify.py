#!/usr/bin/env python3
"""Turn-end balloon for the running JetBrains IDE, tagged with the firing session.

The Stop / AfterAgent hook entrypoint across the three hosts. Where notify.py pops
a fixed string ("Claude finished responding"), this derives a per-tab identity so a
developer juggling many concurrent agent tabs can tell at a glance WHICH session
just yielded:

    title:  <project> · <branch>
    body:   <one-line gist of the agent's last message>

It reads the host's hook payload as JSON on stdin (Claude Code Stop carries `cwd`,
`transcript_path`, `session_id`): `<project>` is the cwd basename, while `<branch>`
and the gist come from the CURRENT turn's assistant reply — the last assistant
text positioned after the last user prompt in the transcript. Anchoring to the
prompt (and briefly polling for the reply to flush) avoids a one-turn lag: the
Stop hook can fire before Claude appends the just-finished reply to the JSONL, so
the newest assistant text on disk may still be the previous turn's. Claude's JSONL
stamps `gitBranch` on every line, so there is no `git` subprocess. The host label
(argv[0], e.g. "Claude") is the fallback title head and the fallback body when no
turn gist is available (the reply never flushed, or a host whose stdin isn't parsed).

Best-effort and SILENT by contract: a missing IDE, absent/foreign stdin, or an
unreadable transcript yields a graceful fallback (or no balloon) and ALWAYS exits 0
— a turn-end hook must never surface an error or block the host. Dynamic text is
HTML-escaped before it reaches the balloon, since IDE notifications render HTML.
"""

import html
import json
import os
import re
import sys
import time

from core import in_idea
from notify import notify

# Body cap: a couple of wrapped balloon lines. Longer gists truncate on a word
# boundary with an ellipsis.
GIST_MAX = 140
# Tail of the transcript to scan (bytes). The last assistant message sits at the
# end; reading a long session's whole JSONL every turn would be wasteful.
TAIL_BYTES = 262_144
# Poll budget for THIS turn's reply to land in the transcript. Claude appends the
# just-finished assistant text to the JSONL a beat AFTER the Stop hook fires, so
# the reply is often missing on the first read; we retry briefly rather than show
# the previous turn's gist. Measured costs (notify ~0.25s, a tail read ~1ms) leave
# ~2.5s of polling comfortably under the hook's 5s timeout.
POLL_TRIES = 25
POLL_DELAY = 0.1

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


def _tail_lines(path: str) -> list[str]:
    """Last TAIL_BYTES of `path` as decoded lines; [] if unreadable."""
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - TAIL_BYTES))
            blob = fh.read()
    except OSError:
        return []
    return blob.decode("utf-8", "replace").splitlines()


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


def _assistant_text(obj: dict) -> str:
    """Concatenated text of an assistant entry; "" for a thinking/tool-only turn.

    `content` is a list of blocks (Claude) or a bare string; only `text` blocks
    contribute, so a turn that only thought or called tools yields "".
    """
    content = obj.get("message", {}).get("content", [])
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def _is_user_prompt(obj: dict) -> bool:
    """True for a real user turn (a typed prompt), False for a tool_result echo.

    Both ride `type == "user"`; a prompt carries string content or a `text` block,
    whereas a tool result carries only `tool_result` blocks. This is the turn
    boundary the gist anchors to.
    """
    content = obj.get("message", {}).get("content", "")
    if isinstance(content, str):
        return bool(content.strip())
    if isinstance(content, list):
        return any(isinstance(b, dict) and b.get("type") == "text" for b in content)
    return False


def _gist_and_branch(transcript_path: str) -> tuple[str | None, str | None]:
    """(gist, branch) for the CURRENT turn — the last assistant text positioned
    *after* the last user prompt in the tail.

    Anchoring to the last user prompt is what fixes the one-turn lag: the Stop hook
    can fire before Claude appends the just-finished reply to the JSONL, so the
    newest assistant text on disk may still be the PREVIOUS turn's. Refusing any
    assistant text at or before the current prompt keeps the gist None until THIS
    turn's reply lands (main() polls for it) — a stale gist is never surfaced.
    `branch` is read off the newest assistant entry (stable across the turn) and
    returned even while the gist is still None.

    Scans the tail in reverse: assistant text seen before the prompt boundary is
    the current turn's; the first user prompt hit (walking back) ends the turn. A
    tail without a user prompt (session start, or a turn larger than TAIL_BYTES)
    falls through to the last assistant text anywhere — best effort.
    """
    branch: str | None = None
    gist: str | None = None
    for line in reversed(_tail_lines(transcript_path)):
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if not isinstance(obj, dict):
            continue
        kind = obj.get("type")
        if kind == "assistant":
            if branch is None:
                branch = obj.get("gitBranch") or None
            if gist is None:
                text = _assistant_text(obj)
                if text.strip():
                    gist = _clean_gist(text)
        elif kind == "user" and _is_user_prompt(obj):
            break  # reached this turn's prompt; anything earlier is a past turn
    return gist, branch


def _await_gist(transcript_path: str) -> tuple[str | None, str | None]:
    """_gist_and_branch, retried until THIS turn's reply has flushed to the JSONL.

    The reply lands a beat after the Stop hook fires, so the first read can come
    back with a None gist; poll up to ~2.5s (POLL_TRIES reads, POLL_DELAY apart,
    within the 5s hook timeout), then give up so the caller falls back to the host
    label. Never
    blocks the host, never shows a stale gist. Returns immediately in the common
    case where the reply is already on disk.
    """
    gist, branch = _gist_and_branch(transcript_path)
    tries = 0
    while gist is None and tries < POLL_TRIES:
        time.sleep(POLL_DELAY)
        tries += 1
        gist, branch = _gist_and_branch(transcript_path)
    return gist, branch


def _title(host: str, cwd: str | None, branch: str | None) -> str:
    """`<project> · <branch>` — project from cwd basename, host label as fallback head."""
    project = os.path.basename(cwd.rstrip("/")) if cwd else ""
    head = project or host
    return f"{head} · {branch}" if branch else head


def main(argv: list[str]) -> int:
    """Pop the turn-end balloon for the firing session; never raise, always exit 0.

    argv[0] is the host label (e.g. "Claude"); it heads the title when no cwd is
    known and is the fallback body when no gist is available.
    """
    host = argv[0] if argv else "Agent"
    try:
        if not in_idea():
            return 0  # not inside a JetBrains IDE: nothing to pop, and no error
        data = _read_hook_input()
        cwd = data.get("cwd") or os.environ.get("PWD")
        transcript = data.get("transcript_path") or data.get("transcriptPath")
        gist, branch = _await_gist(transcript) if transcript else (None, None)
        title = _title(host, cwd, branch)
        body = gist or f"{host} finished responding"
        notify(html.escape(body), title=html.escape(title))
    except Exception:
        pass  # best-effort: a turn-end hook must never error or block the host
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
