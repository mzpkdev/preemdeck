#!/usr/bin/env python3
"""Diff two inline strings in the running JetBrains IDE.

A string-native wrapper over diff_file: each version is spilled to a temp file
and handed to diff_file, which drives the IDE and (with --wait) reads back the
reconciled LEFT pane. The IDE only diffs files, so the temps are the bridge.

Usage:  diff_inline.py <target> <suggestion> [--suffix S] [--wait]
"""

import argparse
import os
import sys
from tempfile import mkstemp

from core import JetBrainsError, reap_later
from diff_file import diff_file


def diff_inline(target: str, suggestion: str, *, suffix: str = ".txt", wait: bool = False) -> str | None:
    """Diff inline strings by spilling each to a temp file, then delegating to diff_file.

    Writes one temp file per version - `target` -> left, `suggestion` -> right -
    and calls `diff_file(target_tmp, suggestion_tmp, wait=wait)` in positional
    order so diff_file watches the correct (LEFT) pane. The return is diff_file's
    own: the LEFT pane's reconciled text on `wait=True`, None on `wait=False`.

    `suffix` is shared by both temps (the versions are the same kind of content)
    and exists only to give the IDE a hint for syntax highlighting.

    Cleanup is gated on `wait`:
    - wait=True: diff_file has blocked until the diff tab closed and returned the
      contents, so the temps are spent; unlink both and return the contents.
    - wait=False: diff_file launched the IDE async and the temps are still open in
      it right now, so they must outlive this call - schedule a deferred reap
      (reap_later) for both and return None.
    The try/finally ensures the synchronous unlink fires only on the wait=True
    path, never out from under an async IDE.
    """
    temps: list[str] = []

    def spill(text: str) -> str:
        fd, path = mkstemp(suffix=suffix)
        with os.fdopen(fd, "w") as f:
            f.write(text)
        temps.append(path)
        return path

    try:
        target_tmp = spill(target)
        suggestion_tmp = spill(suggestion)
        contents = diff_file(target_tmp, suggestion_tmp, wait=wait)
        if not wait:
            # Fire-and-forget: the IDE was launched async and still has both temps
            # open, so schedule a deferred reap instead of leaking them.
            reap_later([target_tmp, suggestion_tmp])
        return contents
    finally:
        # wait=True: diff_file already returned the reconciled text, so the temps
        # are spent and safe to remove synchronously. wait=False: the reap is
        # deferred via reap_later above, never run out from under an async IDE.
        if wait:
            for path in temps:
                os.unlink(path)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="diff_inline.py", description="Diff inline strings in the running JetBrains IDE."
    )
    parser.add_argument("target", help="left pane - the file you reconcile into and get back")
    parser.add_argument("suggestion", help="right pane - the proposed version")
    parser.add_argument("--suffix", default=".txt", help="suffix shared by both temp files (IDE syntax-highlight hint)")
    parser.add_argument(
        "--wait", action="store_true", help="block until the diff tab closes, then print the LEFT pane's contents"
    )
    ns = parser.parse_args(argv)
    try:
        contents = diff_inline(ns.target, ns.suggestion, suffix=ns.suffix, wait=ns.wait)
    except (JetBrainsError, OSError, ValueError) as exc:
        print(f"diff_inline: {exc}", file=sys.stderr)
        return 1
    # Only --wait is result-aware: print the LEFT pane's text. Without it,
    # diff_inline() returns None (fire-and-forget) and nothing is printed.
    if contents is not None:
        print(contents, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
