#!/usr/bin/env python3
"""Open an inline string in the running JetBrains IDE via a temp file.

A thin string-native wrapper over open_file: the string is spilled to a temp
file (named with `suffix` so the IDE picks the right syntax highlighting),
opened, and — on the wait path — the edited text is handed back. The IDE only
opens files, so the temp is the bridge.
"""

import argparse
import os
import sys
import tempfile

from core import JetBrainsError, reap_later
from open_file import open_file


def open_inline(content: str, *, suffix: str = ".txt", wait: bool = False) -> str | None:
    """Open `content` in the running JetBrains IDE by routing it through a temp file.

    `content` is written to a fresh temp file (the fd is closed before opening so
    the IDE sees the complete file) named with `suffix` for syntax highlighting,
    then handed to open_file().

    Cleanup hinges on `wait`:
      * wait=True  -> open_file() blocks and returns the edited text; captures it,
        unlinks the temp, and returns the text.
      * wait=False -> open_file() just launched the IDE async and still needs the
        temp on disk right now; there is no synchronous signal for when it's safe
        to delete, so it schedules a deferred reap (reap_later) and returns None.
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
        # Fire-and-forget: the IDE was launched async and is (or will be) reading
        # `path`, so deleting it now would yank the file out from under the editor.
        # Schedule a deferred reap instead of leaking the temp.
        reap_later([path])
        return None
    finally:
        # Only the wait=True path is safe to clean up synchronously here —
        # open_file() has already returned the edited text, so the temp is done.
        # The wait=False reap is deferred via reap_later above, not run here.
        if wait:
            os.unlink(path)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="open_inline.py",
        description="Open an inline string in the running JetBrains IDE.",
        epilog=(
            "Examples:\n"
            '  open_inline.py "$snippet" --suffix .py   # open with .py highlighting\n'
            '  open_inline.py "$snippet" --wait         # block until closed, then print'
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("inline", help="the literal string to open")
    parser.add_argument(
        "--suffix", default=".txt", help="suffix for the temp file, hints the IDE which syntax to highlight"
    )
    parser.add_argument(
        "--wait", action="store_true", help="block until the tab closes, then print the file's contents"
    )
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
