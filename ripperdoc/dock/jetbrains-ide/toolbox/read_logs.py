#!/usr/bin/env python3
"""Read the last N lines of the running JetBrains IDE's log.

Usage:  read_logs.py [n]   (default 50)
"""

import argparse
import sys

from core import JetBrainsError, resolve_log_dir


def read_logs(n: int = 50) -> list[str]:
    """Last `n` lines of the active IDE's idea.log.

    `resolve_log_dir()` is the single guard for a live IDE: it raises
    JetBrainsError if none is found.
    """
    log = resolve_log_dir() / "idea.log"
    return log.read_text(errors="replace").splitlines()[-n:]


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="read_logs.py", description="Read the last N lines of the running JetBrains IDE's log."
    )
    parser.add_argument("n", type=int, nargs="?", default=50, help="number of trailing log lines to print (default 50)")
    ns = parser.parse_args(argv)
    try:
        lines = read_logs(ns.n)
    except (JetBrainsError, OSError) as exc:
        print(f"read_logs: {exc}", file=sys.stderr)
        return 1
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
