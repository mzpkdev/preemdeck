#!/usr/bin/env python3
"""Diff two files in the running JetBrains IDE.

Usage:  diff_file.py <target> <suggestion> [--wait]
"""

import argparse
import sys
from pathlib import Path

from core import JetBrainsError, launch


def diff_file(target: str, suggestion: str, *, wait: bool = False) -> str | None:
    """Open a 2-way (`target` vs `suggestion`) diff in the running JetBrains IDE.

    The positionals map straight onto `idea diff`'s panes in the given order:
    `diff L R` (passthrough, no reordering) - `target` is the LEFT pane,
    `suggestion` the RIGHT. Both inputs are resolved strictly, so a missing path
    raises FileNotFoundError before anything launches.

    FIRE-AND-FORGET by default (`wait=False`): `launch()` spawns the IDE async and
    the call returns None as soon as the process is started. With `wait=True`,
    `launch()` appends the IDE's native `--wait` itself and blocks until the diff
    tab is closed; the call then reads back and returns the `target` file's full text.

    The LEFT pane (`target`) is the editable/reported side: the user shapes the
    `target` file (typing into it, or pulling chunks from the right `suggestion`
    via the gutter arrows), so the `target` file is what we read back.

    `launch()` is the single guard for a live IDE: it raises JetBrainsError if none
    is found.
    """
    target_abs = str(Path(target).resolve(strict=True))
    suggestion_abs = str(Path(suggestion).resolve(strict=True))
    args = ["diff", target_abs, suggestion_abs]
    # 2-way always watches `target` (LEFT), the editable/reported pane. With
    # wait=True, launch() blocks on the IDE's native --wait; we then read the
    # `target` file back. Do NOT append --wait here - launch() owns that.
    launch(args, wait=wait)
    return Path(target_abs).read_text() if wait else None


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="diff_file.py", description="Diff files in the running JetBrains IDE.")
    parser.add_argument("target", help="left pane - the file you reconcile into and get back")
    parser.add_argument("suggestion", help="right pane - the proposed version")
    parser.add_argument(
        "--wait", action="store_true", help="block until the diff tab closes, then print the LEFT file's contents"
    )
    ns = parser.parse_args(argv)
    try:
        contents = diff_file(ns.target, ns.suggestion, wait=ns.wait)
    except (JetBrainsError, OSError, ValueError) as exc:
        print(f"diff_file: {exc}", file=sys.stderr)
        return 1
    # Only --wait is result-aware: print the LEFT pane's text. Without it,
    # diff_file() returns None (fire-and-forget) and nothing is printed.
    if contents is not None:
        print(contents, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
