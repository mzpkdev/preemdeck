#!/usr/bin/env python3
"""Open an inline string in the running JetBrains IDE via a temp file.

Usage:  open_inline.py <inline> [--suffix S] [--wait]

A thin string-native wrapper over open_file(): writes `content` to a temp file
(named with `suffix` so the IDE picks the right syntax highlighting), opens it,
and — on the wait path — hands back the edited text.
"""

import argparse
import os
import sys
import tempfile

from core import JetBrainsError
from open_file import open_file


def open_inline(content: str, *, suffix: str = ".txt", wait: bool = False) -> str | None:
    """Open `content` in the running JetBrains IDE by routing it through a temp file.

    `content` is written to a fresh temp file (the fd is closed before opening so
    the IDE sees the complete file) named with `suffix` for syntax highlighting,
    then handed to open_file().

    Cleanup hinges on `wait`:
      * wait=True  -> open_file() blocks and returns the edited text; we capture
        it, unlink the temp, and return the text.
      * wait=False -> open_file() just launched the IDE async and still needs the
        temp on disk; we have no signal for when it's safe to delete, so we leave
        it for the OS to reap and return None.
    """
    fd, path = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(content)
        # fd is now closed (os.fdopen's context manager closed it): the IDE opens
        # a fully-written, flushed file.
        contents = open_file(path, wait=wait)
        if wait:
            return contents
        return None
    finally:
        # Only the wait=True path is safe to clean up here — open_file() has
        # already returned the edited text, so the temp is done. On wait=False the
        # IDE was launched async and is (or will be) reading `path`; deleting it
        # would yank the file out from under the editor, so we leave it: no-wait
        # inline leaves the temp for the OS to reap.
        if wait:
            os.unlink(path)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="open_inline.py",
        description="Open an inline string in the running JetBrains IDE.",
    )
    parser.add_argument("inline", help="the literal string to open")
    parser.add_argument("--suffix", default=".txt", help="temp-file suffix for IDE syntax highlighting")
    parser.add_argument("--wait", action="store_true", help="block until edited, then print the contents")
    ns = parser.parse_args(argv)
    try:
        contents = open_inline(ns.inline, suffix=ns.suffix, wait=ns.wait)
    except JetBrainsError as exc:
        print(f"open_inline: {exc}", file=sys.stderr)
        return 1
    # Only --wait is result-aware: print the edited text. Without it, open_inline()
    # returns None (fire-and-forget) and nothing is printed.
    if contents is not None:
        print(contents, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
