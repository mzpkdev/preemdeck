"""Tests for plan_preview — hermetic: no real IDE, the openers are monkeypatched.

plan_preview is the plan-presentation hook (Claude PreToolUse/ExitPlanMode,
Gemini BeforeTool/exit_plan_mode). It reads the hook payload and routes the plan
to the IDE's rendered markdown preview: Gemini's `tool_input.plan_path` straight to
open_file(), Claude's inline `tool_input.plan` to open_inline(--suffix .md). It is
best-effort and silent — gated on a live IDE, swallows failures, always exits 0.

The tests exercise:

- the stdin reader (_read_hook_input) — JSON in, {} on tty/garbage/empty;
- main() end to end with the openers monkeypatched to recorders: the in_idea()
  gate, the per-host field routing (plan_path → open_file, plan → open_inline),
  plan_path precedence, the no-op cases (missing/blank/non-str), and the
  best-effort swallow when an opener raises — all returning 0.
"""

import io

import plan_preview
import pytest

# --- stdin reader ------------------------------------------------------------


def test_read_hook_input_parses_json(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(plan_preview.sys, "stdin", io.StringIO('{"tool_input": {"plan": "hi"}}'))
    assert plan_preview._read_hook_input() == {"tool_input": {"plan": "hi"}}


def test_read_hook_input_garbage_and_empty_yield_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(plan_preview.sys, "stdin", io.StringIO("not json"))
    assert plan_preview._read_hook_input() == {}
    monkeypatch.setattr(plan_preview.sys, "stdin", io.StringIO(""))
    assert plan_preview._read_hook_input() == {}


# --- main() end to end -------------------------------------------------------


def _capture(monkeypatch: pytest.MonkeyPatch) -> dict[str, list]:
    """Replace both openers with recorders and force the IDE gate open.

    Returns {"inline": [...], "file": [...]} capturing (args, kwargs) per opener;
    nothing reaches a real IDE.
    """
    calls: dict[str, list] = {"inline": [], "file": []}
    monkeypatch.setattr(plan_preview, "in_idea", lambda: True)
    monkeypatch.setattr(plan_preview, "open_inline", lambda *a, **k: calls["inline"].append((a, k)))
    monkeypatch.setattr(plan_preview, "open_file", lambda *a, **k: calls["file"].append((a, k)))
    return calls


def test_main_claude_plan_string_opens_inline_as_markdown(monkeypatch: pytest.MonkeyPatch) -> None:
    # Claude PreToolUse/ExitPlanMode: inline markdown string → open_inline(--suffix .md, preview).
    calls = _capture(monkeypatch)
    monkeypatch.setattr(plan_preview, "_read_hook_input", lambda: {"tool_input": {"plan": "# Plan\n\n- step"}})
    assert plan_preview.main() == 0
    assert calls["inline"] == [(("# Plan\n\n- step",), {"suffix": ".md", "preview": True})]
    assert calls["file"] == []


def test_main_gemini_plan_path_opens_file_with_preview(monkeypatch: pytest.MonkeyPatch) -> None:
    # Gemini BeforeTool/exit_plan_mode: finalized file path → open_file(preview).
    calls = _capture(monkeypatch)
    path = "/home/u/.gemini/tmp/proj/plans/plan.md"
    monkeypatch.setattr(plan_preview, "_read_hook_input", lambda: {"tool_input": {"plan_path": path}})
    assert plan_preview.main() == 0
    assert calls["file"] == [((path,), {"preview": True})]
    assert calls["inline"] == []


def test_main_plan_path_takes_precedence_over_plan(monkeypatch: pytest.MonkeyPatch) -> None:
    # Defensive: if both fields somehow appear, the file path wins and inline is skipped.
    calls = _capture(monkeypatch)
    monkeypatch.setattr(
        plan_preview, "_read_hook_input", lambda: {"tool_input": {"plan": "inline", "plan_path": "/p/plan.md"}}
    )
    assert plan_preview.main() == 0
    assert calls["file"] == [(("/p/plan.md",), {"preview": True})]
    assert calls["inline"] == []


def test_main_noop_for_missing_blank_and_non_str(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _capture(monkeypatch)

    def _assert_silent(payload: dict) -> None:
        monkeypatch.setattr(plan_preview, "_read_hook_input", lambda: payload)
        assert plan_preview.main() == 0
        assert calls["inline"] == [] and calls["file"] == []

    _assert_silent({})  # no tool_input at all
    _assert_silent({"tool_input": {}})  # no plan field
    _assert_silent({"tool_input": {"plan": "   "}})  # blank string
    _assert_silent({"tool_input": {"plan_path": ""}})  # empty path
    _assert_silent({"tool_input": {"plan": ["not", "a", "str"]}})  # non-str
    _assert_silent({"tool_input": "not-a-dict"})  # tool_input wrong type


def test_main_gate_no_ide_no_open(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _capture(monkeypatch)
    monkeypatch.setattr(plan_preview, "in_idea", lambda: False)
    monkeypatch.setattr(plan_preview, "_read_hook_input", lambda: {"tool_input": {"plan": "# Plan"}})
    assert plan_preview.main() == 0
    assert calls["inline"] == [] and calls["file"] == []  # gate short-circuits before any open


def test_main_swallows_opener_failure_and_exits_0(monkeypatch: pytest.MonkeyPatch) -> None:
    # An opener raising (e.g. IDE vanished mid-dispatch) must not surface or block the host.
    monkeypatch.setattr(plan_preview, "in_idea", lambda: True)
    monkeypatch.setattr(plan_preview, "_read_hook_input", lambda: {"tool_input": {"plan": "# Plan"}})

    def _boom(*_a: object, **_k: object) -> None:
        raise RuntimeError("IDE went away")

    monkeypatch.setattr(plan_preview, "open_inline", _boom)
    assert plan_preview.main() == 0
