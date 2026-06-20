#!/usr/bin/env python3
"""Open a file in the running JetBrains IDE.

Usage:  open_file.py <path> [--line N] [--column N] [--no-wait]
"""

import subprocess
import sys
from pathlib import Path

from core import JetBrainsError, resolve_exec_path


def open_file(path: str, line: int = 1, column: int | None = None, *, wait: bool = True) -> None:
    """Open `path` at `line` (and optional `column`) in the running JetBrains IDE.

    BLOCKS by default (`wait=True`): launches `idea ... --wait` and joins on the
    launcher, so the call returns only once the tab is closed. With `wait=False`
    it is fire-and-forget: `--wait` is omitted and the launcher is not joined, so
    the call returns as soon as the process is spawned. A failed spawn surfaces
    its OSError to the caller rather than being swallowed; `open_file()` returns
    None either way.
    """
    ide = resolve_exec_path()
    target = str(Path(path).resolve())
    cmd = [ide, "--line", str(line)]
    if column is not None:
        cmd += ["--column", str(column)]
    cmd.append(target)
    if wait:
        cmd.append("--wait")
        subprocess.Popen(cmd).wait()
    else:
        subprocess.Popen(cmd)


_USAGE = "usage: open_file.py <path> [--line N] [--column N] [--no-wait]"


def _take_opt(args: list[str], flag: str) -> str | None:
    """Pop `flag` and its value out of `args` in place; return the value or None.

    Raises ValueError if `flag` is given without a following value.
    """
    if flag not in args:
        return None
    i = args.index(flag)
    if i + 1 >= len(args):
        raise ValueError(f"{flag} requires a value")
    value = args[i + 1]
    del args[i : i + 2]
    return value


def main(argv: list[str]) -> int:
    wait = "--no-wait" not in argv
    args = [a for a in argv if a != "--no-wait"]
    try:
        line_arg = _take_opt(args, "--line")
        column_arg = _take_opt(args, "--column")
    except ValueError as exc:
        print(f"{exc}\n{_USAGE}", file=sys.stderr)
        return 2
    if not args:
        print(_USAGE, file=sys.stderr)
        return 2
    try:
        line = int(line_arg) if line_arg is not None else 1
        column = int(column_arg) if column_arg is not None else None
        open_file(args[0], line, column, wait=wait)
    except (JetBrainsError, OSError, ValueError) as exc:
        print(f"open_file: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
