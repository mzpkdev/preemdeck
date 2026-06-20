#!/usr/bin/env python3
"""Open a file in the running JetBrains IDE.

Usage:  open_file.py <path> [--line N] [--column N] [--wait]
"""

import argparse
import sys
from pathlib import Path

from core import JetBrainsError, launch


def open_file(path: str, line: int = 1, column: int | None = None, *, wait: bool = False) -> str | None:
    """Open `path` at `line` (and optional `column`) in the running JetBrains IDE.

    FIRE-AND-FORGET by default (`wait=False`): `launch()` spawns the IDE async and
    the call returns None as soon as the process is started. With `wait=True`,
    `launch(wait=True)` appends the IDE's native `--wait` and blocks until the tab
    is closed; we then read the file back and return its full text (whether or not
    it was edited). `launch()` is the single guard for a live IDE: it raises
    JetBrainsError if none is found.
    """
    target = str(Path(path).resolve())
    args = ["--line", str(line)]
    if column is not None:
        args += ["--column", str(column)]
    args.append(target)
    launch(args, wait=wait)
    return Path(path).read_text() if wait else None


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="open_file.py", description="Open a file in the running JetBrains IDE.")
    parser.add_argument("path")
    parser.add_argument("--line", type=int, default=1)
    parser.add_argument("--column", type=int, default=None)
    parser.add_argument("--wait", action="store_true", help="block until the file is edited, then print its contents")
    ns = parser.parse_args(argv)
    try:
        contents = open_file(ns.path, ns.line, ns.column, wait=ns.wait)
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
