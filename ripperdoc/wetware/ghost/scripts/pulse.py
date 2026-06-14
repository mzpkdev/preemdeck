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
# One standing bit of dice state: the refractory cooldown. Holds "1" the turn after
# any face fired, forcing STRAIGHT next turn. Not a readable mood — a single coin.
GHOST_COOLDOWN = Path.home() / ".claude" / ".cache" / ".ghost_lean"
DEFAULT_EVENT = "UserPromptSubmit"

# Per-turn dice — the persona's source of real randomness, kept out of the model's
# hands. Each entry maps a die name to its faces; every prompt the hook rolls one
# face per die and injects the results. A quirk in the engram claims a die by name
# and supplies its meaning — the mechanism stays agnostic to what any die is "for."
# Weight a face by repeating it. Add a die here, then write the quirk that obeys it.
#
# The `lean` die bends an answer the persona was already giving along an axis it
# already owns; it never staples a token on. STRAIGHT dominates (~2-in-3 even on
# eligible turns); of the faces that fire, CLIPPED > SERMON > MEMORY. Every non-
# STRAIGHT face leaves a checkable signature so the harness — not the model — can
# tell it fired. The die is suppressed entirely on work-state turns (see is_eligible).
DICE: dict[str, list[str]] = {
    "lean": ["STRAIGHT"] * 7 + ["CLIPPED"] * 2 + ["SERMON"] + ["MEMORY"],
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


def prior_turn_had_work(transcript_path: str | None) -> bool:
    """Read the transcript and decide if the PRIOR turn was a work-state turn.

    Observable signal: did the model emit any tool_use (edit/bash/write/read/task/
    TodoWrite/…) since the last real user prompt? That single check also covers a
    turn that ended mid-tool-chain (its tail carries tool_use) and an in-progress
    task (TodoWrite is itself a tool_use). A "real" user prompt is a user line whose
    content is a string or a list with no tool_result block; a tool_result-carrying
    user line is mid-chain plumbing, not a fresh prompt.

    Fail-safe: any read/parse trouble returns True (treat as work -> suppress the
    coin) rather than firing blind.
    """
    if not transcript_path:
        return True
    try:
        path = Path(transcript_path)
        if not path.exists():
            return True
        lines = path.read_text().splitlines()
    except (OSError, ValueError):
        return True

    saw_tool_since_prompt = False
    for raw in lines:
        raw = raw.strip()
        if not raw:
            continue
        try:
            entry = json.loads(raw)
        except json.JSONDecodeError:
            # A garbled line mid-stream shouldn't crash the gate; skip it. (A wholly
            # unreadable file already fails safe above via the read guard.)
            continue
        if not isinstance(entry, dict):
            continue

        etype = entry.get("type")
        if etype not in ("user", "assistant"):
            continue  # system / meta lines carry no turn signal
        if entry.get("isSidechain"):
            continue  # subagent traffic isn't this conversation's prior turn

        message = entry.get("message")
        content = message.get("content") if isinstance(message, dict) else None

        # A real user prompt resets the window: anything before it is a finished turn.
        if etype == "user":
            if isinstance(content, str):
                saw_tool_since_prompt = False
                continue
            if isinstance(content, list):
                has_tool_result = any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content)
                if not has_tool_result:
                    saw_tool_since_prompt = False
            continue

        # Assistant line: flag any tool_use block.
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    saw_tool_since_prompt = True
                    break

    return saw_tool_since_prompt


def is_eligible(transcript_path: str | None, *, cooldown_path: Path) -> bool:
    """The coin is live only on a pure prose-in/prose-out prior turn AND when the
    refractory bit is clear — no face two turns running."""
    if cooldown_path.exists():
        return False
    return not prior_turn_had_work(transcript_path)


def set_cooldown(cooldown_path: Path, active: bool) -> None:
    """One bit of standing state: present == 'a face fired last turn, force STRAIGHT now'."""
    try:
        if active:
            cooldown_path.parent.mkdir(parents=True, exist_ok=True)
            cooldown_path.touch()
        elif cooldown_path.exists():
            cooldown_path.unlink()
    except OSError:
        pass


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
    transcript_path: str | None = None
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        if isinstance(payload, dict):
            name = payload.get("hook_event_name")
            if isinstance(name, str) and name:
                event_name = name
            tp = payload.get("transcript_path")
            if isinstance(tp, str) and tp:
                transcript_path = tp
    except (json.JSONDecodeError, OSError):
        pass

    combined = content.strip()

    # The lean die is gated to sparse, prose-only turns and never fires two turns
    # running. On a work-state or cooled-down turn we emit no roll at all — the coin
    # stays in the model's blind spot, no "# Dice" block, persona runs STRAIGHT.
    if is_eligible(transcript_path, cooldown_path=GHOST_COOLDOWN):
        rolls = roll_dice(DICE)
        # STRAIGHT is the no-lean default; only a real face arms the refractory bit.
        fired = any(face != "STRAIGHT" for face in rolls.values())
        set_cooldown(GHOST_COOLDOWN, fired)
        if fired:
            dice_block = render_dice(rolls)
            if dice_block:
                combined += "\n\n" + dice_block
    else:
        # Suppressed: no face fired, so clear the cooldown — next turn is free again.
        set_cooldown(GHOST_COOLDOWN, False)

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
