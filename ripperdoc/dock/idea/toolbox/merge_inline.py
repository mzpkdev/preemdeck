#!/usr/bin/env python3
"""3-way merge of inline strings (with an optional base) in the running JetBrains IDE.

A string-native wrapper over merge_file: each version is spilled to a temp file
and handed to merge_file, which drives the IDE's native 3-way merge and (with
--wait) reads back the resolved result. The IDE only merges files, so the temps
are the bridge.
"""

import argparse
import os
import sys
from tempfile import mkstemp

from core import IdeaError, in_idea, reap_later
from merge_file import merge_file


def merge_inline(
    target: str, suggestion: str, base: str | None = None, *, suffix: str = ".txt", wait: bool = False
) -> str | None:
    """Merge inline strings by spilling each to a temp file, then delegating to merge_file.

    Writes one temp per version — `target`, `suggestion`, and `base` ONLY when it
    is not None — and calls `merge_file(target_tmp, suggestion_tmp, base_tmp, wait=wait)`
    (merge_file mints its own internal OUTPUT temp). The return is merge_file's own:
    the resolved merge text on `wait=True`, None on `wait=False`.

    `suffix` is shared by every temp (the versions are the same kind of content)
    and exists only to give the IDE a hint for syntax highlighting.

    Cleanup is gated on `wait`:
    - wait=True: merge_file has blocked until the user applied and returned the
      result, so the input temps are spent; unlink them and return the result.
    - wait=False: merge_file launched the IDE async and the input temps are still
      open in it right now, so they must outlive this call — schedule a deferred
      reap (reap_later) for them and return None. The OUTPUT temp is owned by
      merge_file, which reaps it itself.
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
        base_tmp = spill(base) if base is not None else None
        result = merge_file(target_tmp, suggestion_tmp, base_tmp, wait=wait)
        if not wait:
            # Fire-and-forget: the IDE was launched async and still has the input
            # temps open, so schedule a deferred reap instead of leaking them. The
            # output temp is merge_file's to reap, so it's not in `temps`.
            reap_later(temps)
        return result
    finally:
        # wait=True: merge_file already returned the resolved text, so the input
        # temps are spent and safe to remove synchronously. wait=False: the reap is
        # deferred via reap_later above, never run out from under an async IDE.
        if wait:
            for path in temps:
                os.unlink(path)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="merge_inline.py",
        description="3-way merge inline strings in the running JetBrains IDE.",
        epilog=(
            "Examples:\n"
            '  merge_inline.py "$mine" "$theirs" "$base" --suffix .py  # merge with a base\n'
            '  merge_inline.py "$mine" "$theirs" --wait                # block until applied'
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("target", help="local pane — your version")
    parser.add_argument("suggestion", help="remote pane — the proposed version")
    parser.add_argument("base", nargs="?", help="optional common ancestor (the 3-way base)")
    parser.add_argument(
        "--suffix", default=".txt", help="suffix for every temp file, hints the IDE which syntax to highlight"
    )
    parser.add_argument(
        "--wait", action="store_true", help="block until the user applies, then print the merged result"
    )
    ns = parser.parse_args(argv)
    try:
        # Cheap CLI gate: fail fast/clean outside a JetBrains terminal, before
        # merge_file()/launch()'s deeper resolve_exec_path() ancestry walk. Reuse
        # the IdeaError path so the message matches the resolver-triggered failure.
        if not in_idea():
            raise IdeaError("no JetBrains IDE in the process ancestry")
        result = merge_inline(ns.target, ns.suggestion, ns.base, suffix=ns.suffix, wait=ns.wait)
    except (IdeaError, OSError, ValueError) as exc:
        print(f"merge_inline: {exc}", file=sys.stderr)
        return 1
    # Only --wait is result-aware: print the merged result. Without it,
    # merge_inline() returns None (fire-and-forget) and nothing is printed.
    if result is not None:
        print(result, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
