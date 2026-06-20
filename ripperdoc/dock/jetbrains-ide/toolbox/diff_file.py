#!/usr/bin/env python3
"""Diff two (or three) files in the running JetBrains IDE.

Usage:  diff_file.py <left> <right> [<third>] [--no-wait]
"""

import subprocess
import sys
from pathlib import Path

from core import JetBrainsError, resolve_exec_path


def _snapshot(p: Path) -> tuple:
    """A cheap identity for `p`: (exists, mtime_ns, size). Missing -> (False, 0, 0)."""
    try:
        st = p.stat()
        return (True, st.st_mtime_ns, st.st_size)
    except FileNotFoundError:
        return (False, 0, 0)


def diff_file(left: str, right: str, third: str | None = None, *, wait: bool = True) -> bool | None:
    """Open a 2-way (`left` vs `right`) or 3-way diff in the running JetBrains IDE.

    The positionals map straight onto `idea diff`'s panes in the given order: two
    paths launch `idea diff L R`, three launch `idea diff L M R` (passthrough, no
    reordering). BLOCKS by default (`wait=True`): launches with `--wait` and joins
    on the launcher, so the call returns only once the viewer is dismissed. With
    `wait=False` it is fire-and-forget: `--wait` is omitted and the launcher is not
    joined, so the call returns as soon as the process is spawned. Every input is
    resolved strictly, so a missing path raises FileNotFoundError before anything
    launches. A failed spawn surfaces its OSError to the caller rather than being
    swallowed.

    RESULT AWARENESS differs by arity:

    2-way (`third is None`) + `wait=True` is the only result-aware path. `<left>`
    is the editable/reported side: it's the file you want changes read back from, so
    put it first; the reference goes second/right. The user shapes the LEFT file
    (typing into it, or pulling chunks from the right reference via the gutter
    arrows), so the LEFT file is what we watch. The right pane is reference-only:
    edits there are intentionally ignored and not reported. Returns True iff the
    human edited `<left>` during the diff, else False - detection is stat-based
    (mtime_ns+size via the shared snapshot), so it flags *a write*, not a net content
    change: an edit-then-revert reads as edited.

    3-way (`third is not None`) is comparison-only and always returns None, even
    when blocking. It launches (and joins, if `wait=True`) but never snapshots:
    which pane IntelliJ makes editable in a 3-way diff is unverified, so reporting
    off the wrong pane would be wrong - we decline to report rather than guess.

    `wait=False` is also comparison-only for both arities: there is nothing to join,
    so edits can't be observed and it returns None.
    """
    ide = resolve_exec_path()
    left = Path(left).resolve(strict=True)
    left_abs = str(left)
    right_abs = str(Path(right).resolve(strict=True))
    cmd = [ide, "diff", left_abs, right_abs]
    if third is not None:
        cmd.append(str(Path(third).resolve(strict=True)))
    if not wait:
        subprocess.Popen(cmd)
        return None
    cmd.append("--wait")
    # 3-way is comparison-only: no editable pane we trust, so launch, join, report
    # nothing. Only the 2-way blocking path snapshots the left pane for an edit.
    if third is not None:
        subprocess.Popen(cmd).wait()
        return None
    before = _snapshot(left)
    subprocess.Popen(cmd).wait()
    # The after-snapshot assumes the IDE flushed `<left>` to disk before --wait
    # returned (untested in mocks, where Popen is stubbed out).
    after = _snapshot(left)
    return after != before


_USAGE = "usage: diff_file.py <left> <right> [<third>] [--no-wait]"


def main(argv: list[str]) -> int:
    wait = "--no-wait" not in argv
    args = [a for a in argv if a != "--no-wait"]
    if len(args) not in (2, 3):
        print(_USAGE, file=sys.stderr)
        return 2
    try:
        # 2 positionals -> 2-way; 3 -> 3-way passthrough (third pane).
        edited = diff_file(*args, wait=wait)
    except (JetBrainsError, OSError, ValueError) as exc:
        print(f"diff_file: {exc}", file=sys.stderr)
        return 1
    # Only the 2-way blocking path is result-aware: it reports the review outcome on
    # stdout, where "unchanged" is a valid result, NOT a failure, so both branches
    # exit 0. 3-way and --no-wait return None (comparison-only) -> nothing printed,
    # still exit 0.
    if edited is not None:
        print("edited" if edited else "unchanged")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
