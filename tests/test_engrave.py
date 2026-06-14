"""Tests for the ghost memory engraver (engrave.py).

Regression coverage for the bug where Claude Code logs tool results,
subagent task-notifications, and skill output as role:"user". Those entries
must NOT be classified as the human speaking, or they get tagged USER: and
engraved as bogus user memories.
"""

import importlib.util
from pathlib import Path

import pytest

# engrave.py lives outside the importable root, so load it by path.
_ENGRAVE_PATH = Path(__file__).parents[1] / "ripperdoc" / "wetware" / "ghost" / "scripts" / "engrave.py"
_spec = importlib.util.spec_from_file_location("engrave", _ENGRAVE_PATH)
assert _spec is not None and _spec.loader is not None
engrave = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(engrave)


# _parse_entry — non-human role:"user" entries are excluded


def test_parse_entry_excludes_tool_result_list_content() -> None:
    entry = {
        "type": "user",
        "message": {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": "abc", "content": "some tool output"},
            ],
        },
    }
    assert engrave._parse_entry(entry) is None


def test_parse_entry_excludes_tool_use_list_content() -> None:
    entry = {
        "type": "user",
        "message": {
            "role": "user",
            "content": [
                {"type": "tool_use", "id": "abc", "name": "Bash", "input": {"command": "ls"}},
            ],
        },
    }
    assert engrave._parse_entry(entry) is None


def test_parse_entry_excludes_task_notification_string() -> None:
    entry = {
        "type": "user",
        "message": {
            "role": "user",
            "content": "<task-notification>agent finished</task-notification>",
        },
    }
    assert engrave._parse_entry(entry) is None


def test_parse_entry_excludes_command_message_string() -> None:
    entry = {
        "type": "user",
        "message": {"role": "user", "content": "<command-message>ghost:debug</command-message>"},
    }
    assert engrave._parse_entry(entry) is None


def test_parse_entry_excludes_command_name_string() -> None:
    entry = {
        "type": "user",
        "message": {"role": "user", "content": "<command-name>/ghost:debug</command-name>"},
    }
    assert engrave._parse_entry(entry) is None


def test_parse_entry_excludes_task_notification_with_leading_whitespace() -> None:
    entry = {
        "type": "user",
        "message": {"role": "user", "content": "\n  <task-notification>done</task-notification>"},
    }
    assert engrave._parse_entry(entry) is None


# _parse_entry — genuine messages still parse


def test_parse_entry_keeps_genuine_user_string() -> None:
    entry = {"type": "user", "message": {"role": "user", "content": "I prefer X"}}
    assert engrave._parse_entry(entry) == ("user", "I prefer X")


def test_parse_entry_keeps_genuine_user_text_block() -> None:
    entry = {
        "type": "user",
        "message": {"role": "user", "content": [{"type": "text", "text": "I prefer X"}]},
    }
    assert engrave._parse_entry(entry) == ("user", "I prefer X")


def test_parse_entry_classifies_assistant_not_user() -> None:
    entry = {
        "type": "assistant",
        "message": {
            "role": "assistant",
            "content": [{"type": "text", "text": "Yeah. The third task pushed both fixes."}],
        },
    }
    result = engrave._parse_entry(entry)
    assert result is not None
    role, text = result
    assert role == "assistant"
    assert text == "Yeah. The third task pushed both fixes."
    # Confirms it will not survive the USER: filter downstream.
    assert not f"{role.upper()}: {text}".startswith("USER:")


# _extract_text — only text blocks contribute


def test_extract_text_ignores_tool_blocks_returns_only_text() -> None:
    content = [
        {"type": "tool_use", "id": "1", "name": "Bash", "input": {"command": "ls"}},
        {"type": "tool_result", "tool_use_id": "1", "content": "file output"},
        {"type": "text", "text": "the real text"},
    ]
    assert engrave._extract_text(content) == "the real text"


def test_extract_text_plain_string_returned_as_is() -> None:
    assert engrave._extract_text("just a string") == "just a string"


def test_extract_text_gemini_bare_text_block_preserved() -> None:
    # Gemini stores {text: ...} with no "type" key; must still be harvested.
    assert engrave._extract_text([{"text": "gemini text"}]) == "gemini text"


# read_transcript — end-to-end exclusion through the public entrypoint


def test_read_transcript_filters_tool_noise_keeps_user(tmp_path: Path) -> None:
    entries = [
        {"type": "user", "message": {"role": "user", "content": "I prefer dark mode"}},
        {
            "type": "user",
            "message": {"role": "user", "content": [{"type": "tool_result", "content": "DB dump"}]},
        },
        {
            "type": "user",
            "message": {"role": "user", "content": "<task-notification>done</task-notification>"},
        },
        {
            "type": "assistant",
            "message": {"role": "assistant", "content": [{"type": "text", "text": "in-character reply"}]},
        },
    ]
    transcript = tmp_path / "session.jsonl"
    transcript.write_text("\n".join(__import__("json").dumps(e) for e in entries))

    lines = engrave.read_transcript(str(transcript))
    user_lines = [ln for ln in lines if ln.startswith("USER:")]
    assert user_lines == ["USER: I prefer dark mode"]
    # tool_result, task-notification, and assistant lines are not USER lines.
    assert not any("DB dump" in ln for ln in user_lines)
    assert not any("task-notification" in ln for ln in user_lines)
    assert not any("in-character reply" in ln for ln in user_lines)


# _damp_toward_good — asymmetric rapport gain (slow climb, fast fall)
#
# Toward-good deltas are scaled by GAIN_FACTOR and rounded up (away from zero);
# away-from-good and zero deltas pass through unchanged. trust/attachment have
# good=high (+1); instability has good=0/low (-1), so its polarity is inverted.


@pytest.mark.parametrize(
    ("field", "delta", "expected"),
    [
        ("trust", 3, 1),  # ceil(3*0.33)=ceil(0.99)=1
        ("trust", 10, 4),  # ceil(3.3)=4
        ("trust", 1, 1),  # ceil(0.33)=1 — nudge survives
        ("trust", -3, -3),  # away from good — full
        ("trust", -10, -10),
        ("trust", 0, 0),
        ("attachment", 6, 2),  # ceil(1.98)=2
        ("attachment", -6, -6),  # away — full
        ("attachment", 1, 1),  # nudge survives
        ("instability", 5, 5),  # away from good (up) — full
        ("instability", 10, 10),
        ("instability", -5, -2),  # toward 0 — ceil(1.65)=2 -> -2
        ("instability", -10, -4),  # ceil(3.3)=4 -> -4
        ("instability", -1, -1),  # cooling nudge survives
        ("instability", 0, 0),
    ],
)
def test_damp_toward_good_truth_table(field: str, delta: int, expected: int) -> None:
    assert engrave._damp_toward_good(field, delta) == expected


def test_damp_toward_good_nudge_survives_every_field() -> None:
    # A one-unit move toward each field's good pole must stay nonzero (ceil keeps it 1).
    for field in engrave.RAPPORT_FIELDS:
        toward_good = engrave.GOOD_DIRECTION[field]
        assert engrave._damp_toward_good(field, toward_good) == toward_good


def test_damp_toward_good_instability_inverted() -> None:
    # instability cools slow (damped) but spikes fast (full) — inverted vs trust.
    assert engrave._damp_toward_good("instability", -10) == -4
    assert engrave._damp_toward_good("instability", 10) == 10


# apply_rapport_deltas — a gain climbs slower than an equal-magnitude loss drops


def _fresh_db(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, name: str) -> Path:
    """Point engrave.DB_PATH at a fresh tmp sqlite and init it."""
    db_path = tmp_path / name
    monkeypatch.setattr(engrave, "DB_PATH", db_path)
    engrave.init_db()
    return db_path


def test_apply_rapport_gain_slower_than_loss(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # From identical fresh states: +6 trust (toward good) damps to +2, but -6
    # trust (away from good) falls the full -6. Losing a good state is faster
    # than earning it back.
    _fresh_db(monkeypatch, tmp_path, "gain.db")
    gain = engrave.apply_rapport_deltas({"trust": 6})
    assert gain["trust"] == 2

    _fresh_db(monkeypatch, tmp_path, "loss.db")
    loss = engrave.apply_rapport_deltas({"trust": -6})
    assert loss["trust"] == -6

    assert abs(loss["trust"]) > abs(gain["trust"])


def test_apply_rapport_instability_spikes_fast_cools_slow(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # instability spikes full-strength (+6) but cools slow: from 6, a -6 cooling
    # delta damps to -2, landing at 4.
    _fresh_db(monkeypatch, tmp_path, "instab.db")
    spike = engrave.apply_rapport_deltas({"instability": 6})
    assert spike["instability"] == 6
    cool = engrave.apply_rapport_deltas({"instability": -6})
    assert cool["instability"] == 4
