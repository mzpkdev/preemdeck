"""Tests for turn_notify — hermetic: no real IDE, no ideScript, no subprocess.

turn_notify is the Stop / AfterAgent hook entrypoint: it reads the host's hook
payload, derives `<project> · <branch>` + a one-line gist of the last assistant
message from the transcript, and pops a balloon via notify(). The tests exercise:

- the pure formatters (_clean_gist, _title) — markdown stripping, line selection,
  truncation, and the project/branch/host-fallback title shape;
- transcript parsing (_gist_and_branch) against a synthetic JSONL tail — the
  CURRENT turn's reply (last assistant text after the last user prompt) wins,
  gitBranch is read off the entry, foreign/empty lines skip, and a not-yet-flushed
  reply withholds the gist rather than leaking the previous turn's;
- the flush poll (_await_gist) — retries until the reply lands, gives up at budget;
- prompt/tool_result discrimination (_is_user_prompt);
- the stdin reader (_read_hook_input) — JSON in, {} on tty/garbage;
- main() end to end with the notify worker monkeypatched to a recorder: the
  in_idea() gate, the (title, body) it would fire, HTML-escaping of dynamic text,
  and the host-label fallback when no transcript is available.
"""

import io
import json

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


# --- transcript parsing ------------------------------------------------------


def _write_transcript(path, entries: list[dict]) -> str:
    path.write_text("\n".join(json.dumps(e) for e in entries))
    return str(path)


def test_gist_and_branch_picks_last_assistant_text(tmp_path) -> None:
    tx = _write_transcript(
        tmp_path / "t.jsonl",
        [
            {"type": "assistant", "gitBranch": "main", "message": {"content": [{"type": "text", "text": "first"}]}},
            {"type": "user", "message": {"content": [{"type": "text", "text": "ignored"}]}},
            {
                "type": "assistant",
                "gitBranch": "feat/x",
                "message": {"content": [{"type": "text", "text": "Latest reply."}]},
            },
        ],
    )
    assert turn_notify._gist_and_branch(tx) == ("Latest reply.", "feat/x")


def test_gist_and_branch_skips_toolonly_turns_and_handles_string_content(tmp_path) -> None:
    tx = _write_transcript(
        tmp_path / "t.jsonl",
        [
            {"type": "assistant", "gitBranch": "main", "message": {"content": "bare string body"}},
            {"type": "assistant", "gitBranch": "main", "message": {"content": [{"type": "tool_use", "name": "Bash"}]}},
        ],
    )
    # newest entry is tool-only (no text) -> falls back to the older string-content turn.
    assert turn_notify._gist_and_branch(tx) == ("bare string body", "main")


def test_gist_and_branch_unreadable_path_is_silent() -> None:
    assert turn_notify._gist_and_branch("/no/such/transcript.jsonl") == (None, None)


# --- turn anchoring: never leak the previous turn ----------------------------


def test_is_user_prompt_distinguishes_prompt_from_tool_result() -> None:
    assert turn_notify._is_user_prompt({"message": {"content": "real prompt"}}) is True
    assert turn_notify._is_user_prompt({"message": {"content": [{"type": "text", "text": "hi"}]}}) is True
    # a tool_result echo rides type==user too, but is NOT a turn boundary
    assert turn_notify._is_user_prompt({"message": {"content": [{"type": "tool_result", "content": "out"}]}}) is False
    assert turn_notify._is_user_prompt({"message": {"content": ""}}) is False


def test_gist_holds_none_until_current_reply_flushes(tmp_path) -> None:
    # The lag, reproduced: the previous turn's reply is on disk and the new prompt
    # has arrived, but THIS turn has only emitted a tool call so far (its final
    # text isn't appended yet). The gist must NOT fall back to "OLD answer";
    # branch is still known from the fresh tool-call entry.
    tx = _write_transcript(
        tmp_path / "t.jsonl",
        [
            {
                "type": "assistant",
                "gitBranch": "main",
                "message": {"content": [{"type": "text", "text": "OLD answer"}]},
            },
            {"type": "user", "message": {"content": "new question"}},
            {"type": "assistant", "gitBranch": "main", "message": {"content": [{"type": "tool_use", "name": "Bash"}]}},
            {"type": "user", "message": {"content": [{"type": "tool_result", "content": "ok"}]}},
        ],
    )
    assert turn_notify._gist_and_branch(tx) == (None, "main")


def test_gist_returns_current_reply_after_prompt(tmp_path) -> None:
    # Same shape as above, but the turn's final text has now landed after the
    # tool round-trip: it wins over the previous turn's "OLD answer".
    tx = _write_transcript(
        tmp_path / "t.jsonl",
        [
            {
                "type": "assistant",
                "gitBranch": "main",
                "message": {"content": [{"type": "text", "text": "OLD answer"}]},
            },
            {"type": "user", "message": {"content": "new question"}},
            {"type": "assistant", "gitBranch": "main", "message": {"content": [{"type": "tool_use", "name": "Bash"}]}},
            {"type": "user", "message": {"content": [{"type": "tool_result", "content": "ok"}]}},
            {
                "type": "assistant",
                "gitBranch": "main",
                "message": {"content": [{"type": "text", "text": "FRESH reply"}]},
            },
        ],
    )
    assert turn_notify._gist_and_branch(tx) == ("FRESH reply", "main")


# --- the flush poll (_await_gist) --------------------------------------------


def test_await_gist_polls_until_reply_lands(monkeypatch: pytest.MonkeyPatch) -> None:
    slept: list[float] = []
    monkeypatch.setattr(turn_notify.time, "sleep", lambda d: slept.append(d))
    results = iter([(None, "main"), (None, "main"), ("landed", "main")])
    monkeypatch.setattr(turn_notify, "_gist_and_branch", lambda _p: next(results))
    assert turn_notify._await_gist("/x.jsonl") == ("landed", "main")
    assert len(slept) == 2  # two retries before the reply showed up


def test_await_gist_gives_up_after_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    slept: list[float] = []
    monkeypatch.setattr(turn_notify.time, "sleep", lambda d: slept.append(d))
    monkeypatch.setattr(turn_notify, "_gist_and_branch", lambda _p: (None, "main"))
    assert turn_notify._await_gist("/x.jsonl") == (None, "main")  # never landed
    assert len(slept) == turn_notify.POLL_TRIES  # budget exhausted, no infinite loop


# --- stdin reader ------------------------------------------------------------


def test_read_hook_input_parses_json(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(turn_notify.sys, "stdin", io.StringIO('{"cwd": "/x", "transcript_path": "/y"}'))
    assert turn_notify._read_hook_input() == {"cwd": "/x", "transcript_path": "/y"}


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


def test_main_fires_rich_copy_from_transcript(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    tx = _write_transcript(
        tmp_path / "t.jsonl",
        [
            {
                "type": "assistant",
                "gitBranch": "main",
                "message": {"content": [{"type": "text", "text": "Probed the hook."}]},
            }
        ],
    )
    calls = _capture(monkeypatch)
    monkeypatch.setattr(turn_notify, "_read_hook_input", lambda: {"cwd": "/work/acme", "transcript_path": tx})
    assert turn_notify.main(["Claude"]) == 0
    assert calls == [{"title": "acme · main", "body": "Probed the hook."}]


def test_main_falls_back_rather_than_leaking_previous_gist(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    # End to end: this turn's reply hasn't flushed, so after the poll budget the
    # balloon shows the host string — NEVER the stale "OLD answer". Title keeps the
    # branch off the fresh tool-call entry. Sleep is stubbed so the poll is instant.
    monkeypatch.setattr(turn_notify.time, "sleep", lambda _d: None)
    tx = _write_transcript(
        tmp_path / "t.jsonl",
        [
            {
                "type": "assistant",
                "gitBranch": "main",
                "message": {"content": [{"type": "text", "text": "OLD answer"}]},
            },
            {"type": "user", "message": {"content": "new question"}},
            {"type": "assistant", "gitBranch": "main", "message": {"content": [{"type": "tool_use", "name": "Bash"}]}},
        ],
    )
    calls = _capture(monkeypatch)
    monkeypatch.setattr(turn_notify, "_read_hook_input", lambda: {"cwd": "/work/acme", "transcript_path": tx})
    assert turn_notify.main(["Claude"]) == 0
    assert calls == [{"title": "acme · main", "body": "Claude finished responding"}]


def test_main_html_escapes_dynamic_text(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    tx = _write_transcript(
        tmp_path / "t.jsonl",
        [
            {
                "type": "assistant",
                "gitBranch": "main",
                "message": {"content": [{"type": "text", "text": "use <T> & <U>"}]},
            }
        ],
    )
    calls = _capture(monkeypatch)
    monkeypatch.setattr(turn_notify, "_read_hook_input", lambda: {"cwd": "/x/proj", "transcript_path": tx})
    turn_notify.main(["Claude"])
    assert calls[0]["body"] == "use &lt;T&gt; &amp; &lt;U&gt;"


def test_main_falls_back_to_host_label_without_transcript(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _capture(monkeypatch)
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
