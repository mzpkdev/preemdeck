#!/usr/bin/env python3
"""Open a file in the running JetBrains IDE.

Usage:  open_file.py <path> [line] [--confirm]
"""

import re
import subprocess
import sys
import time
from pathlib import Path

from core import JetBrainsError, resolve_exec_path, resolve_log_dir

_CONFIRM_TIMEOUT = 3.0  # seconds to wait for the open to land in the log
_CONFIRM_POLL = 0.25  # seconds between log reads
_TS = re.compile(r"^\d{4}-\d\d-\d\d ")  # a fresh log entry starts with a date


def _launch(ide: str, line: int, target: str) -> bool:
    try:
        subprocess.Popen([ide, "--line", str(line), target])
    except OSError:
        return False
    return True


def _opened_via_cli(lines: list[str], target: str) -> bool:
    """True only if `target` is the file inside a CommandLineProcessor open block."""
    for i, ln in enumerate(lines):
        if "External command line:" in ln:
            for cont in lines[i + 1 :]:
                if _TS.match(cont):  # next timestamped entry -> block ended
                    break
                if cont.strip() == target:  # exact path, inside THIS block
                    return True
    return False


def open_file(path: str, line: int = 1, *, confirm: bool = False) -> bool:
    """Open `path` at `line` in the running JetBrains IDE.

    Fire-and-forget by default - returns True once the launcher spawns. With
    confirm=True, polls the IDE log (up to 3s, every 250ms) and returns whether
    this exact file's open was recorded inside its CommandLineProcessor block,
    so opening other files concurrently can't false-positive it.
    """
    ide = resolve_exec_path()
    target = str(Path(path).resolve())

    if not confirm:
        return _launch(ide, line, target)

    log = resolve_log_dir() / "idea.log"
    seen = len(log.read_text(errors="replace").splitlines()) if log.exists() else 0
    if not _launch(ide, line, target):
        return False

    deadline = time.monotonic() + _CONFIRM_TIMEOUT
    while time.monotonic() < deadline:
        fresh = log.read_text(errors="replace").splitlines()[seen:]
        if _opened_via_cli(fresh, target):
            return True
        time.sleep(_CONFIRM_POLL)
    return False


def main(argv: list[str]) -> int:
    confirm = "--confirm" in argv
    args = [a for a in argv if a != "--confirm"]
    if not args:
        print("usage: open_file.py <path> [line] [--confirm]", file=sys.stderr)
        return 2
    try:
        line = int(args[1]) if len(args) > 1 else 1
        ok = open_file(args[0], line, confirm=confirm)
    except (JetBrainsError, OSError, ValueError) as exc:
        print(f"open_file: {exc}", file=sys.stderr)
        return 1
    if confirm and not ok:
        print("open_file: open not confirmed within timeout", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
