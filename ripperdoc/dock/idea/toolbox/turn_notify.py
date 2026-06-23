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
and the gist come from the transcript's last assistant message — Claude's JSONL
stamps `gitBranch` on every line, so there is no `git` subprocess. The host label
(argv[0], e.g. "Claude") is the fallback title head and the fallback body when no
transcript gist is available (e.g. a host whose stdin shape isn't parsed yet).

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

from core import in_idea
from notify import notify

# Body cap: a couple of wrapped balloon lines. Longer gists truncate on a word
# boundary with an ellipsis.
GIST_MAX = 140
# Tail of the transcript to scan (bytes). The last assistant message sits at the
# end; reading a long session's whole JSONL every turn would be wasteful.
TAIL_BYTES = 262_144

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


def _gist_and_branch(transcript_path: str) -> tuple[str | None, str | None]:
    """(gist, branch) from the transcript's last assistant text message.

    Scans the tail in reverse for the last `type == "assistant"` entry whose
    message carries non-empty text; `gitBranch` is read off the same entry. Either
    element is None when unavailable (no text yet, or a transcript without the
    field). `content` may be a list of blocks (Claude) or a bare string.
    """
    branch: str | None = None
    for line in reversed(_tail_lines(transcript_path)):
        if '"assistant"' not in line:  # cheap prefilter before the JSON parse
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if not isinstance(obj, dict) or obj.get("type") != "assistant":
            continue
        if branch is None:
            branch = obj.get("gitBranch") or None
        content = obj.get("message", {}).get("content", [])
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            text = "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
        else:
            text = ""
        if text.strip():
            return _clean_gist(text), branch
    return None, branch


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
        gist, branch = _gist_and_branch(transcript) if transcript else (None, None)
        title = _title(host, cwd, branch)
        body = gist or f"{host} finished responding"
        notify(html.escape(body), title=html.escape(title))
    except Exception:
        pass  # best-effort: a turn-end hook must never error or block the host
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
