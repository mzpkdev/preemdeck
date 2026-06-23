#!/usr/bin/env python3
"""Open an agent's freshly-presented plan in the IDE's rendered markdown preview.

The plan-presentation hook entrypoint, shared by two hosts that fire a pre-tool
event the moment the agent exits plan mode:

    Claude  PreToolUse  matcher ExitPlanMode    tool_input.plan       (markdown string)
    Gemini  BeforeTool  matcher exit_plan_mode  tool_input.plan_path  (markdown file)

Both fire BEFORE the host's approval gate, so the rendered plan pops in the IDE
while the terminal still shows approve/reject — the user reads the formatted
version to decide. The script is host-agnostic: it branches on which field the
payload carries, not on a host label. Claude hands the plan inline (spilled to a
temp via open_inline); Gemini hands a path to an already-written file (opened
directly via open_file). Both opens are fire-and-forget + `--preview`.

Codex has no analog wired: its only plan primitive, `update_plan`, is a recurring
TODO checklist, not a one-shot prose plan at an approval gate — so it is not
matched and never reaches here.

Best-effort and SILENT by contract, like turn_notify: a missing IDE, absent or
foreign stdin, or any open failure yields a no-op and ALWAYS exits 0 with empty
stdout. A pre-tool hook that exits 0 with no stdout lets the host proceed to its
normal approval gate unchanged; erroring or printing a decision payload would
disrupt it.
"""

import json
import sys

from core import in_idea
from open_file import open_file
from open_inline import open_inline


def _read_hook_input() -> dict:
    """Parse the hook's stdin payload as JSON; {} on anything unexpected.

    Guards `isatty()` so a host that leaves stdin attached to the terminal (rather
    than piping a payload) never blocks the read.
    """
    try:
        if sys.stdin.isatty():
            return {}
        raw = sys.stdin.read()
    except Exception:
        return {}
    try:
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _open_plan(tool_input: dict) -> None:
    """Dispatch the plan to the IDE's rendered preview by which field is present.

    `plan_path` (Gemini's finalized markdown file) is checked first and opened
    directly; otherwise `plan` (Claude's inline markdown string) is spilled to a
    `.md` temp and opened. The two are host-exclusive, so the order is just
    defensive. Anything else (no plan field, blank, or non-string) is a no-op.
    """
    plan_path = tool_input.get("plan_path")
    if isinstance(plan_path, str) and plan_path.strip():
        open_file(plan_path, preview=True)
        return
    plan = tool_input.get("plan")
    if isinstance(plan, str) and plan.strip():
        open_inline(plan, suffix=".md", preview=True)


def main() -> int:
    """Pop the plan preview for the firing host; never raise, always exit 0.

    Gate on a live IDE first (no IDE → nothing to preview, and no error), then
    read the payload and dispatch. Every failure is swallowed so a pre-tool hook
    never blocks the host or leaks a decision payload to stdout.
    """
    try:
        if not in_idea():
            return 0  # not inside a JetBrains IDE: nothing to open, and no error
        data = _read_hook_input()
        tool_input = data.get("tool_input")
        if isinstance(tool_input, dict):
            _open_plan(tool_input)
    except Exception:
        pass  # best-effort: a pre-tool hook must never error or block the host
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
