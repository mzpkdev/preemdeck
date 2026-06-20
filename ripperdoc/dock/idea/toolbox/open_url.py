#!/usr/bin/env python3
"""Open an http/https URL in the running JetBrains IDE's embedded JCEF preview."""

import argparse
import sys
from urllib.parse import urlsplit

from core import IdeaError, in_idea, preview_url, resolve_exec_path


def open_url(url: str, title: str | None = None) -> None:
    """Open `url` in the running IDE's embedded JCEF web-preview tab.

    FIRE-AND-FORGET: there is no editor to block on, so unlike open_file there is
    no `--wait`. The tab is titled "Preview of <title>"; `title` defaults to the
    URL's host[:port] (see preview_url).

    Clean-fail, NOT a browser fallback: resolve_exec_path() is the single guard
    for a live IDE — it raises IdeaError (no IDE in the ancestry) or
    NotImplementedError (non-macOS stub), which the CLI turns into a non-zero
    exit. Because the IDE preview is the only thing this command can do, there is
    deliberately no shell-out to `open`/a browser when it's unavailable. With a
    live IDE confirmed, preview_url() fires the ideScript (the in-IDE registry
    gate handles a JCEF-off WebStorm as a clean no-op).
    """
    resolve_exec_path()
    preview_url(url, title)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="open_url.py",
        description="Open an http/https URL in the running JetBrains IDE's embedded JCEF preview.",
        epilog=(
            "Examples:\n"
            "  open_url.py http://localhost:3000              # preview a local dev server\n"
            "  open_url.py https://example.com --title docs   # custom tab label"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("url", help="http/https URL to open in the embedded preview")
    parser.add_argument("--title", default=None, help="tab label (default the URL's host[:port])")
    ns = parser.parse_args(argv)
    # Light validation: a non-empty http/https URL. The IDE's JCEF preview only
    # speaks http(s), so reject anything else up front with a clear note.
    if urlsplit(ns.url).scheme not in {"http", "https"}:
        print("open_url: url must be a non-empty http/https URL", file=sys.stderr)
        return 1
    try:
        # Cheap CLI gate: fail fast/clean outside a JetBrains terminal, before
        # resolve_exec_path()'s deeper ancestry walk. Reuse the IdeaError
        # path so the message is identical to the resolver-triggered failure.
        if not in_idea():
            raise IdeaError("no JetBrains IDE in the process ancestry")
        open_url(ns.url, ns.title)
    except (IdeaError, NotImplementedError) as exc:
        print(f"open_url: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
