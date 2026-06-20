#!/usr/bin/env python3
"""Report whether this terminal is running inside a JetBrains IDE.

The same cheap gate every other tool in the toolbox applies before it acts:
true when this terminal was launched by a JetBrains IDE, false otherwise. The
result is the process exit code (0 inside, 1 outside), so it doubles as a shell
gate; without -q it also prints a human-readable line.
"""

import argparse
import sys

from core import in_idea


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="in_idea.py",
        description="Report whether this terminal is running inside a JetBrains IDE.",
        epilog=(
            "Exit status: 0 inside a JetBrains IDE terminal, 1 outside it — so it "
            "works as a shell gate.\n\n"
            "Examples:\n"
            "  in_idea.py        # print yes/no and set the exit code\n"
            "  in_idea.py -q     # no output, just the exit code"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "-q",
        "--quiet",
        action="store_true",
        help="print nothing; signal the result through the exit code only",
    )
    ns = parser.parse_args(argv)
    try:
        inside = in_idea()
    except NotImplementedError as exc:
        print(f"in_idea: {exc}", file=sys.stderr)
        return 1
    if not ns.quiet:
        print("in a JetBrains IDE terminal" if inside else "not in a JetBrains IDE terminal")
    return 0 if inside else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
