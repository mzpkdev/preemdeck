#!/usr/bin/env python3
"""Show a directive body — print skills/<value>/directive.md verbatim.

Usage: show_mode.py <value>

The per-mode echo skills (/swarm, /ask, /auto) invoke this to display their own
directive without writing anything. It is read-only: it never touches
preemdeck.json. <value> must be a bare name — anything carrying a path separator
or a dot-segment is rejected, so it can't escape the skills dir (the same guard
inject_mode's load_mode_text uses). The body is printed exactly as it ships, no
framing. Same input → same bytes.

Exit codes:
  0  directive printed
  2  usage error, unsafe value, or no matching skills/<value>/directive.md
"""

from __future__ import annotations

import sys
from pathlib import Path

SKILLS_DIR = Path(__file__).resolve().parents[1] / "skills"


def available_modes() -> list[str]:
    """Sorted mode names — skill folders that ship a `directive.md`."""
    if not SKILLS_DIR.is_dir():
        return []
    return sorted(d.name for d in SKILLS_DIR.iterdir() if d.is_dir() and (d / "directive.md").is_file())


def main(argv: list[str]) -> int:
    modes = available_modes()
    listing = ", ".join(modes) or "none"
    if len(argv) != 1 or not argv[0].strip():
        print(f"usage: show_mode.py <value>   (values: {listing})", file=sys.stderr)
        return 2
    value = argv[0].strip()
    if Path(value).name != value:  # path separator or dot-segment — refuse to escape
        print(f"unsafe value {value!r}; available: {listing}", file=sys.stderr)
        return 2
    body = SKILLS_DIR / value / "directive.md"
    if not body.is_file():
        print(f"unknown value {value!r}; available: {listing}", file=sys.stderr)
        return 2
    sys.stdout.write(body.read_text(encoding="utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
