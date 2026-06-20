#!/usr/bin/env python3
"""3-way merge of two files (with an optional base) in the running JetBrains IDE.

Usage:  merge_file.py <target> <suggestion> [base] [--wait]
"""

import argparse
import os
import sys
import tempfile
from pathlib import Path

from core import JetBrainsError, launch, reap_later


def merge_file(target: str, suggestion: str, base: str | None = None, *, wait: bool = False) -> str | None:
    """Open a 3-way merge of `target` and `suggestion` (with optional `base`) in the IDE.

    The positionals are READ-ONLY inputs resolved strictly, so a missing path
    raises FileNotFoundError before anything launches. They map onto `idea merge`'s
    fixed arg order, where the OUTPUT comes LAST and the BASE (when present) is THIRD:
    `merge <local> <remote> [<base>] <output>`. We never touch the inputs; the
    resolution lands in an internal output temp created here (not a caller arg),
    suffixed to mirror the target's extension so the IDE highlights it.

    Unlike `diff`, `idea merge` BLOCKS natively until the user hits Apply - there is
    no `--wait` flag (and a 4-arg `merge --wait` risks rejection). So `launch()` is
    called with the default `wait=False` (async spawn, no `--wait`) and we join the
    process OURSELVES with `proc.wait()`.

    FIRE-AND-FORGET by default (`wait=False`): the IDE is spawned and the call
    returns None immediately; the output temp is scheduled for a deferred reap
    (reap_later) rather than leaked, since we have no synchronous signal for when
    the IDE is done with it. With `wait=True`, we block on the spawned process,
    then read back and return the resolved output's full text, unlinking the
    output temp on the way out (try/finally - wait path only, after the read).

    `launch()` is the single guard for a live IDE: it raises JetBrainsError if none
    is found.
    """
    target_abs = str(Path(target).resolve(strict=True))
    suggestion_abs = str(Path(suggestion).resolve(strict=True))
    base_abs = str(Path(base).resolve(strict=True)) if base is not None else None

    # Internal output temp (not a caller arg). Mirror the target's extension for
    # syntax highlighting when it has one, else fall back to a plain default.
    suffix = Path(target_abs).suffix or ".txt"
    fd, output = tempfile.mkstemp(suffix=suffix)
    os.close(fd)

    # Fixed arg order: output LAST, base THIRD when present. No --wait - merge
    # blocks natively, so we spawn async and join the process ourselves below.
    if base_abs is None:
        argv = ["merge", target_abs, suggestion_abs, output]
    else:
        argv = ["merge", target_abs, suggestion_abs, base_abs, output]
    proc = launch(argv)

    if not wait:
        # Fire-and-forget: the IDE may still write `output` after the user applies,
        # so we can't unlink it now; schedule a deferred reap instead of leaking it
        # (same deferred-cleanup rule as the inline tools).
        reap_later([output])
        return None
    try:
        # merge blocks natively; joining the spawned process is how we wait for Apply.
        proc.wait()
        return Path(output).read_text()
    finally:
        # Read is done (or failed) - the output temp is spent; remove it. Only the
        # wait path reaches here, so an async IDE never has its output yanked away.
        os.unlink(output)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="merge_file.py", description="3-way merge files in the running JetBrains IDE."
    )
    parser.add_argument("target", help="local pane - your version")
    parser.add_argument("suggestion", help="remote pane - the proposed version")
    parser.add_argument("base", nargs="?", help="optional common ancestor (the 3-way base)")
    parser.add_argument(
        "--wait", action="store_true", help="block until the user applies, then print the merged result"
    )
    ns = parser.parse_args(argv)
    try:
        result = merge_file(ns.target, ns.suggestion, ns.base, wait=ns.wait)
    except (JetBrainsError, OSError, ValueError) as exc:
        print(f"merge_file: {exc}", file=sys.stderr)
        return 1
    # Only --wait is result-aware: print the merged result. Without it, merge_file()
    # returns None (fire-and-forget) and nothing is printed.
    if result is not None:
        print(result, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
