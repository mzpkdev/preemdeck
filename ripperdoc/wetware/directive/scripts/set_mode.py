#!/usr/bin/env python3
"""Set one directive slot in preemdeck.json — the deterministic writer the mode
skills call.

Usage: set_mode.py <slot> <value>

Each mode skill (skills/<value>/SKILL.md) invokes this with its own slot+value, so
invoking the skill is what writes the choice. All the determinism lives here, not
in the calling model: <value> is validated against the shipped mode skills
(skills/<value>/directive.md — the same set the inject_mode hook serves), <slot>
against the slots already present in the `directive` object, preemdeck.json is
located by walking up from this script (same resolution the hook uses),
`directive[<slot>]` is set while every other slot and top-level key is preserved,
and the file is rewritten atomically with fixed 2-space framing. Same input →
same bytes.

Exit codes:
  0  slot set (idempotent — setting the current value is a no-op rewrite)
  2  usage error, unknown value/slot, or preemdeck.json not found
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

CONFIG_NAME = "preemdeck.json"
DIRECTIVE_KEY = "directive"
SEARCH_START = Path(__file__).resolve().parent
SKILLS_DIR = Path(__file__).resolve().parents[1] / "skills"


def find_config(start: Path) -> Path | None:
    """Walk up from `start` (inclusive) toward the filesystem root; first hit wins."""
    for parent in (start, *start.parents):
        candidate = parent / CONFIG_NAME
        if candidate.is_file():
            return candidate
    return None


def available_modes() -> list[str]:
    """Sorted mode names — skill folders that ship a `directive.md`."""
    if not SKILLS_DIR.is_dir():
        return []
    return sorted(d.name for d in SKILLS_DIR.iterdir() if d.is_dir() and (d / "directive.md").is_file())


def config_slots(config: Path) -> list[str]:
    """Slot keys already defined in the config's `directive` object (insertion order)."""
    try:
        data = json.loads(config.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    field = data.get(DIRECTIVE_KEY) if isinstance(data, dict) else None
    return list(field.keys()) if isinstance(field, dict) else []


def set_directive(config: Path, slot: str, value: str) -> None:
    """Set `directive[slot] = value`, preserving other slots/keys; atomic write."""
    try:
        data = json.loads(config.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    field = data.get(DIRECTIVE_KEY)
    if not isinstance(field, dict):
        field = {}
    field[slot] = value
    data[DIRECTIVE_KEY] = field
    payload = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    tmp = config.with_suffix(config.suffix + ".tmp")
    tmp.write_text(payload, encoding="utf-8")
    os.replace(tmp, config)  # atomic swap — never leaves a half-written config


def main(argv: list[str]) -> int:
    modes = available_modes()
    listing = ", ".join(modes) or "none"
    if len(argv) != 2 or not argv[0].strip() or not argv[1].strip():
        print(f"usage: set_mode.py <slot> <value>   (values: {listing})", file=sys.stderr)
        return 2
    slot, value = argv[0].strip(), argv[1].strip()
    if value not in modes:
        print(f"unknown value {value!r}; available: {listing}", file=sys.stderr)
        return 2
    config = find_config(SEARCH_START)
    if config is None:
        print(f"{CONFIG_NAME} not found above {SEARCH_START}", file=sys.stderr)
        return 2
    slots = config_slots(config)
    if slot not in slots:
        slisting = ", ".join(slots) or "none"
        print(f"unknown slot {slot!r}; defined slots: {slisting}", file=sys.stderr)
        return 2
    set_directive(config, slot, value)
    print(f"{DIRECTIVE_KEY}.{slot} = {value}  ({config})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
