"""Tests for turn_notify — hermetic: no real IDE, no ideScript; git is monkeypatched.

turn_notify is the Stop / AfterAgent hook entrypoint: it reads the host's hook
payload, derives `<project> · <branch>` + a one-line gist of the agent's last
reply, and pops a balloon via notify(). Every host hands the reply text straight to
the hook (last_assistant_message on Claude/Codex, prompt_response on Gemini), so
there is no transcript parsing; the branch comes from a `git rev-parse`
(monkeypatched here). The tests exercise:

- the pure formatters (_clean_gist, _title) — markdown stripping, line selection,
  truncation, and the project/branch/host-fallback title shape;
- the payload gist (_payload_gist) — the per-host reply fields, with missing /
  blank / sentinel all yielding None;
- the branch fallback (_git_branch) — current branch, detached/empty/no-cwd/error → None;
- the stdin reader (_read_hook_input) — JSON in, {} on tty/garbage;
- main() end to end with the notify worker monkeypatched to a recorder: the
  in_idea() gate, per-host gist sourcing, the (title, body) it would fire,
  HTML-escaping, and the host-label fallback (tool-only turn / empty payload).
"""

import io

import pytest
import turn_notify

# --- pure formatters ---------------------------------------------------------


def test_clean_gist_strips_markdown_and_takes_first_answer_line() -> None:
    text = '> ### Re: "old"\n\n**Yes** — the `pid` lives in the [backend](http://x) only.'
    # blockquote/heading lines skipped; emphasis/ticks dropped; link unwrapped.
    assert turn_notify._clean_gist(text) == "Yes — the pid lives in the backend only."


def test_clean_gist_truncates_on_word_boundary_with_ellipsis() -> None:
    gist = turn_notify._clean_gist("word " * 60)
    assert len(gist) <= turn_notify.GIST_MAX + 1  # +1 for the ellipsis char
    assert gist.endswith("…") and "  " not in gist


def test_title_variants() -> None:
    assert turn_notify._title("Claude", "/work/acme", "main") == "acme · main"
    assert turn_notify._title("Claude", "/work/acme/", None) == "acme"  # trailing slash tolerated
    assert turn_notify._title("Claude", None, None) == "Claude"  # host fallback head


# --- payload gist (all hosts) ------------------------------------------------


def test_payload_gist_reads_each_host_field() -> None:
    # Claude/Codex Stop → last_assistant_message; Gemini AfterAgent → prompt_response.
    # Both get the same _clean_gist treatment (here: emphasis stripped).
    assert turn_notify._payload_gist({"last_assistant_message": "**Done** — wired it."}) == "Done — wired it."
    assert turn_notify._payload_gist({"prompt_response": "Converted to async/await."}) == "Converted to async/await."


def test_payload_gist_none_for_missing_blank_and_sentinel() -> None:
    assert turn_notify._payload_gist({}) is None  # no reply field at all
    assert turn_notify._payload_gist({"last_assistant_message": None}) is None  # optional field, tool-only turn
    assert turn_notify._payload_gist({"prompt_response": "   "}) is None  # blank
    assert turn_notify._payload_gist({"prompt_response": "[no response text]"}) is None  # Gemini sentinel


# --- branch fallback (git rev-parse) -----------------------------------------


class _FakeProc:
    """Stand-in for subprocess.CompletedProcess — only the fields _git_branch reads."""

    def __init__(self, stdout: str, returncode: int = 0) -> None:
        self.stdout = stdout
        self.returncode = returncode


def test_git_branch_returns_current_branch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(turn_notify.subprocess, "run", lambda *a, **k: _FakeProc("feature/x\n"))
    assert turn_notify._git_branch("/repo") == "feature/x"


def test_git_branch_none_for_no_cwd_detached_empty_and_error(monkeypatch: pytest.MonkeyPatch) -> None:
    assert turn_notify._git_branch(None) is None  # no cwd → no subprocess at all
    monkeypatch.setattr(turn_notify.subprocess, "run", lambda *a, **k: _FakeProc("HEAD\n"))
    assert turn_notify._git_branch("/repo") is None  # detached HEAD
    monkeypatch.setattr(turn_notify.subprocess, "run", lambda *a, **k: _FakeProc("", returncode=128))
    assert turn_notify._git_branch("/repo") is None  # not a repo (non-zero exit)

    def _boom(*_a: object, **_k: object) -> None:
        raise OSError("git not found")

    monkeypatch.setattr(turn_notify.subprocess, "run", _boom)
    assert turn_notify._git_branch("/repo") is None  # spawn error swallowed


# --- stdin reader ------------------------------------------------------------


def test_read_hook_input_parses_json(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(turn_notify.sys, "stdin", io.StringIO('{"cwd": "/x", "last_assistant_message": "hi"}'))
    assert turn_notify._read_hook_input() == {"cwd": "/x", "last_assistant_message": "hi"}


def test_read_hook_input_garbage_and_empty_yield_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(turn_notify.sys, "stdin", io.StringIO("not json"))
    assert turn_notify._read_hook_input() == {}
    monkeypatch.setattr(turn_notify.sys, "stdin", io.StringIO(""))
    assert turn_notify._read_hook_input() == {}


# --- main() end to end -------------------------------------------------------


def _capture(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    """Replace the notify worker with a recorder; nothing reaches ideScript."""
    calls: list[dict] = []
    monkeypatch.setattr(turn_notify, "in_idea", lambda: True)
    monkeypatch.setattr(
        turn_notify, "notify", lambda message, title="PreemDeck": calls.append({"body": message, "title": title})
    )
    return calls


def test_main_claude_gist_from_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    # Claude: gist from last_assistant_message, branch from git — no transcript read.
    calls = _capture(monkeypatch)
    monkeypatch.setattr(turn_notify, "_git_branch", lambda _cwd: "main")
    monkeypatch.setattr(
        turn_notify, "_read_hook_input", lambda: {"cwd": "/work/acme", "last_assistant_message": "Probed the hook."}
    )
    assert turn_notify.main(["Claude"]) == 0
    assert calls == [{"title": "acme · main", "body": "Probed the hook."}]


def test_main_codex_shares_last_assistant_message(monkeypatch: pytest.MonkeyPatch) -> None:
    # Codex reads the same last_assistant_message field as Claude.
    calls = _capture(monkeypatch)
    monkeypatch.setattr(turn_notify, "_git_branch", lambda _cwd: "feat/codex")
    monkeypatch.setattr(
        turn_notify, "_read_hook_input", lambda: {"cwd": "/work/acme", "last_assistant_message": "Wired the Stop hook."}
    )
    assert turn_notify.main(["Codex"]) == 0
    assert calls == [{"title": "acme · feat/codex", "body": "Wired the Stop hook."}]


def test_main_gemini_gist_from_prompt_response(monkeypatch: pytest.MonkeyPatch) -> None:
    # Gemini: gist from prompt_response.
    calls = _capture(monkeypatch)
    monkeypatch.setattr(turn_notify, "_git_branch", lambda _cwd: "main")
    monkeypatch.setattr(
        turn_notify,
        "_read_hook_input",
        lambda: {"cwd": "/work/acme", "prompt_response": "Converted the middleware to async/await."},
    )
    assert turn_notify.main(["Gemini"]) == 0
    assert calls == [{"title": "acme · main", "body": "Converted the middleware to async/await."}]


def test_main_tool_only_turn_falls_back_to_host_label(monkeypatch: pytest.MonkeyPatch) -> None:
    # Optional reply field absent (tool-only final turn) → host-label body, while
    # project + branch still enrich the title.
    calls = _capture(monkeypatch)
    monkeypatch.setattr(turn_notify, "_git_branch", lambda _cwd: "feat/codex")
    monkeypatch.setattr(turn_notify, "_read_hook_input", lambda: {"cwd": "/work/acme", "last_assistant_message": None})
    assert turn_notify.main(["Codex"]) == 0
    assert calls == [{"title": "acme · feat/codex", "body": "Codex finished responding"}]


def test_main_html_escapes_dynamic_text(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _capture(monkeypatch)
    monkeypatch.setattr(turn_notify, "_git_branch", lambda _cwd: None)
    monkeypatch.setattr(
        turn_notify, "_read_hook_input", lambda: {"cwd": "/x/proj", "last_assistant_message": "use <T> & <U>"}
    )
    turn_notify.main(["Claude"])
    assert calls[0]["body"] == "use &lt;T&gt; &amp; &lt;U&gt;"


def test_main_falls_back_to_host_label_without_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _capture(monkeypatch)
    monkeypatch.setattr(turn_notify, "_git_branch", lambda _cwd: None)
    monkeypatch.setattr(turn_notify, "_read_hook_input", lambda: {})
    monkeypatch.delenv("PWD", raising=False)  # no cwd anywhere -> host-label title head
    assert turn_notify.main(["Gemini"]) == 0
    assert calls == [{"title": "Gemini", "body": "Gemini finished responding"}]


def test_main_gate_no_ide_no_balloon(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict] = []
    monkeypatch.setattr(turn_notify, "in_idea", lambda: False)
    monkeypatch.setattr(turn_notify, "notify", lambda *a, **k: calls.append({}))
    assert turn_notify.main(["Claude"]) == 0
    assert calls == []  # gate short-circuits before the worker
