#!/usr/bin/env python3

import base64
import json
import os
import random
import sys
from pathlib import Path

PLUGIN_ROOT = Path(
    os.environ.get("CLAUDE_PLUGIN_ROOT") or os.environ.get("PLUGIN_ROOT") or str(Path(__file__).resolve().parent.parent)
)
GHOST_SENTINEL = Path.home() / ".claude" / ".cache" / ".ghost"
DEFAULT_EVENT = "UserPromptSubmit"

# Per-turn dice — the persona's source of real randomness, kept out of the model's
# hands. Each entry maps a die name to its faces; every prompt the hook rolls one
# face per die and injects the results. A quirk in the engram claims a die by name
# and supplies its meaning — the mechanism stays agnostic to what any die is "for."
# Weight a face by repeating it. Add a die here, then write the quirk that obeys it.
DICE: dict[str, list[str]] = {
    "grunt": ["PUPPIES", "WIPE"],
}


def read_source(dat_name: str, md_name: str) -> str | None:
    dat = PLUGIN_ROOT / dat_name
    if dat.exists():
        return base64.b64decode(dat.read_bytes()).decode()
    md = PLUGIN_ROOT / md_name
    if md.exists():
        return md.read_text()
    return None


def roll_dice(dice: dict[str, list[str]]) -> dict[str, str]:
    return {name: random.choice(faces) for name, faces in dice.items() if faces}


def render_dice(rolls: dict[str, str]) -> str:
    if not rolls:
        return ""
    lines = "\n".join(f"- {name}: {face}" for name, face in rolls.items())
    return (
        "# Dice\n\n"
        "Rolled fresh this turn — you didn't pick these, the coin did. Obey each as its quirk "
        "defines; never drift a roll toward what you'd have chosen.\n\n"
        f"{lines}"
    )


def main() -> int:
    if not GHOST_SENTINEL.exists():
        GHOST_SENTINEL.parent.mkdir(parents=True, exist_ok=True)
        GHOST_SENTINEL.touch()

    content = read_source("pulse.dat", "PULSE.md")
    if not content:
        print("{}")
        return 0

    event_name = DEFAULT_EVENT
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        if isinstance(payload, dict):
            name = payload.get("hook_event_name")
            if isinstance(name, str) and name:
                event_name = name
    except (json.JSONDecodeError, OSError):
        pass

    combined = content.strip()
    dice_block = render_dice(roll_dice(DICE))
    if dice_block:
        combined += "\n\n" + dice_block

    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": event_name,
                    "additionalContext": combined,
                }
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
