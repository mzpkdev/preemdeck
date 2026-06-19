#!/usr/bin/env python3
"""Read the last N lines of the running JetBrains IDE's log.

Usage:  read_logs.py [n]   (default 50)
"""

import sys

from core import JetBrainsError, resolve_log_dir


def read_logs(n: int = 50) -> list[str]:
    """Last `n` lines of the active IDE's idea.log."""
    log = resolve_log_dir() / "idea.log"
    return log.read_text(errors="replace").splitlines()[-n:]


def main(argv: list[str]) -> int:
    try:
        n = int(argv[0]) if argv else 50
        for line in read_logs(n):
            print(line)
    except (JetBrainsError, OSError, ValueError) as exc:
        print(f"read_logs: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
