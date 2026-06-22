#!/usr/bin/env python3
"""Set the active mode in preemdeck.json — the deterministic /mode writer.

Usage: set_mode.py <mode>

All the determinism lives here, not in the calling model: <mode> is validated
against the shipped modes/<mode>.md files (the same set the inject_mode hook can
serve), preemdeck.json is located by walking up from this script (same
resolution the hook uses), the `mode-example` field is set while every other key
is preserved, and the file is rewritten atomically with fixed 2-space framing.
Same input → same bytes.

Exit codes:
  0  mode set (idempotent — setting the current mode is a no-op rewrite)
  2  usage error, unknown mode, or preemdeck.json not found
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

CONFIG_NAME = "preemdeck.json"
MODE_KEY = "mode-example"
SEARCH_START = Path(__file__).resolve().parent
MODES_DIR = Path(__file__).resolve().parents[1] / "modes"


def find_config(start: Path) -> Path | None:
    """Walk up from `start` (inclusive) toward the filesystem root; first hit wins."""
    for parent in (start, *start.parents):
        candidate = parent / CONFIG_NAME
        if candidate.is_file():
            return candidate
    return None


def available_modes() -> list[str]:
    """Sorted stems of the shipped modes/*.md files — the only accepted values."""
    if not MODES_DIR.is_dir():
        return []
    return sorted(p.stem for p in MODES_DIR.glob("*.md"))


def set_mode(config: Path, mode: str) -> None:
    """Set `MODE_KEY = mode` in `config`, preserving other keys; atomic write."""
    try:
        data = json.loads(config.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    data[MODE_KEY] = mode
    payload = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    tmp = config.with_suffix(config.suffix + ".tmp")
    tmp.write_text(payload, encoding="utf-8")
    os.replace(tmp, config)  # atomic swap — never leaves a half-written config


def main(argv: list[str]) -> int:
    modes = available_modes()
    listing = ", ".join(modes) or "none"
    if len(argv) != 1 or not argv[0].strip():
        print(f"usage: set_mode.py <mode>   (available: {listing})", file=sys.stderr)
        return 2
    mode = argv[0].strip()
    if mode not in modes:
        print(f"unknown mode {mode!r}; available: {listing}", file=sys.stderr)
        return 2
    config = find_config(SEARCH_START)
    if config is None:
        print(f"{CONFIG_NAME} not found above {SEARCH_START}", file=sys.stderr)
        return 2
    set_mode(config, mode)
    print(f"{MODE_KEY} = {mode}  ({config})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
