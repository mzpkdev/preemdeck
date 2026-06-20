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

from core import IdeaError, in_idea, reap_later
from open_file import open_file


def open_inline(content: str, *, suffix: str = ".txt", wait: bool = False, preview: bool = False) -> str | None:
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

    Opt-in `preview=True` (default off) is threaded straight to open_file(), which
    flips the editor to WebStorm's rendered preview after the open. It previews
    the spilled temp — which works because the temp carries `suffix`, so the IDE
    treats it as the right filetype (e.g. `--suffix .md` -> a previewable editor).
    """
    fd, path = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(content)
        # fd is now closed (os.fdopen's context manager closed it): the IDE opens
        # a fully-written, flushed file.
        contents = open_file(path, wait=wait, preview=preview)
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
            '  open_inline.py "$snippet" --suffix .py        # open with .py highlighting\n'
            '  open_inline.py "$snippet" --wait              # block until closed, then print\n'
            '  open_inline.py "$md" --suffix .md --preview   # open, then flip to rendered preview'
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
    parser.add_argument(
        "--preview",
        action="store_true",
        help="after opening, flip the editor to WebStorm's rendered preview (best-effort; no-op for non-preview types)",
    )
    ns = parser.parse_args(argv)
    try:
        # Cheap CLI gate: fail fast/clean outside a JetBrains terminal, before
        # open_file()/launch()'s deeper resolve_exec_path() ancestry walk. Reuse
        # the IdeaError path so the message matches the resolver-triggered failure.
        if not in_idea():
            raise IdeaError("no JetBrains IDE in the process ancestry")
        contents = open_inline(ns.inline, suffix=ns.suffix, wait=ns.wait, preview=ns.preview)
    except IdeaError as exc:
        print(f"open_inline: {exc}", file=sys.stderr)
        return 1
    # Only --wait is result-aware: print the edited text. Without it, open_inline()
    # returns None (fire-and-forget) and nothing is printed.
    if contents is not None:
        print(contents, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
