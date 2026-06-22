#!/usr/bin/env python3
"""Set a directive in preemdeck.json — the deterministic writer, derived by value.

Usage: set_mode.py <value>

The single setter skill (/directive:default) invokes this with a value, so
invoking it is what writes the choice. All the determinism lives here, not in the
calling model: <value> is validated against the shipped mode skills
(skills/<value>/directive.md — the same set the inject_mode hook serves); its slot
is *derived* from scripts/modes.json (the central value→slot manifest), so the
value alone decides which slot it lands in. preemdeck.json is located by walking up
from this script (same resolution the hook uses), the derived slot is checked
against the slots already present in the `directive` object, `directive[<slot>]` is
set while every other slot and top-level key is preserved, and the file is
rewritten atomically with fixed 2-space framing. Same input → same bytes.

Exit codes:
  0  slot set (idempotent — setting the current value is a no-op rewrite)
  2  usage error, unknown value, no slot for the value in modes.json, missing or
     malformed modes.json, unknown derived slot, or preemdeck.json not found
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
MODES_FILE = Path(__file__).resolve().parent / "modes.json"


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


def slot_for(value: str) -> str | None:
    """The slot a value maps to in scripts/modes.json; None if it has no entry.

    Raises ValueError if modes.json is missing, unreadable, or not a JSON object —
    a broken manifest is a hard error, distinct from a value simply not being in it.
    """
    try:
        data = json.loads(MODES_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise ValueError(f"{MODES_FILE} missing or malformed") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{MODES_FILE} missing or malformed")
    slot = data.get(value)
    return slot if isinstance(slot, str) and slot.strip() else None


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
    if len(argv) != 1 or not argv[0].strip():
        print(f"usage: set_mode.py <value>   (values: {listing})", file=sys.stderr)
        return 2
    value = argv[0].strip()
    if value not in modes:
        print(f"unknown value {value!r}; available: {listing}", file=sys.stderr)
        return 2
    try:
        slot = slot_for(value)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    if slot is None:
        print(f"mode {value!r} has no slot in modes.json", file=sys.stderr)
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
