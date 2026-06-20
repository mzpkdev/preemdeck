#!/usr/bin/env python3
"""Open a file in the running JetBrains IDE."""

import argparse
import sys
from pathlib import Path

from core import JetBrainsError, launch, set_preview


def open_file(
    path: str, line: int = 1, column: int | None = None, *, wait: bool = False, preview: bool = False
) -> str | None:
    """Open `path` at `line` (and optional `column`) in the running JetBrains IDE.

    FIRE-AND-FORGET by default (`wait=False`): `launch()` spawns the IDE async and
    the call returns None as soon as the process is started. With `wait=True`,
    `launch(wait=True)` appends the IDE's native `--wait` and blocks until the tab
    is closed; then reads the file back and returns its full text (whether or not
    it was edited). `launch()` is the single guard for a live IDE: it raises
    JetBrainsError if none is found.

    Opt-in `preview=True` (default off) layers a best-effort step AFTER the open:
    set_preview() flips the editor to WebStorm's rendered preview via ideScript.
    The default path is untouched — when `preview` is False, set_preview() is
    never called and no ideScript fires. set_preview() never raises: if preview
    can't be set it degrades with a stderr note, so the open still succeeds.
    """
    target = str(Path(path).resolve())
    args = ["--line", str(line)]
    if column is not None:
        args += ["--column", str(column)]
    args.append(target)
    launch(args, wait=wait)
    if preview:
        set_preview(target)
    return Path(path).read_text() if wait else None


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="open_file.py",
        description="Open a file in the running JetBrains IDE.",
        epilog=(
            "Examples:\n"
            "  open_file.py src/app.py --line 42   # jump to line 42, fire-and-forget\n"
            "  open_file.py notes.md --wait        # block until closed, then print the file\n"
            "  open_file.py notes.md --preview     # open, then flip to rendered preview"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("path", help="file to open")
    parser.add_argument("--line", type=int, default=1, help="1-based line to put the caret on (default 1)")
    parser.add_argument("--column", type=int, default=None, help="1-based column to put the caret on")
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
        contents = open_file(ns.path, ns.line, ns.column, wait=ns.wait, preview=ns.preview)
    except JetBrainsError as exc:
        print(f"open_file: {exc}", file=sys.stderr)
        return 1
    # Only --wait is result-aware: print the edited file text. Without it,
    # open_file() returns None (fire-and-forget) and nothing is printed.
    if contents is not None:
        print(contents, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
