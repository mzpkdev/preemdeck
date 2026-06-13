import importlib.util
import json
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

spec = importlib.util.spec_from_file_location("engrave", Path(__file__).parent / "engrave.py")
assert spec is not None and spec.loader is not None
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

_extract_text = mod._extract_text
_parse_entry = mod._parse_entry
_build_argv = mod._build_argv
read_transcript = mod.read_transcript
passes_prefilter = mod.passes_prefilter
passes_rapport_prefilter = mod.passes_rapport_prefilter
apply_rapport_deltas = mod.apply_rapport_deltas
score_rapport = mod.score_rapport
init_db = mod.init_db
PERSONA_RE = mod.PERSONA_RE
RAPPORT_FIELDS = mod.RAPPORT_FIELDS
DELTA_CAP = mod.DELTA_CAP
TOTAL_CAP = mod.TOTAL_CAP


# ── _extract_text ─────────────────────────────────────────────────────────────


class TestExtractText:
    def test_plain_string(self):
        assert _extract_text("hello") == "hello"

    def test_empty_string(self):
        assert _extract_text("") == ""

    def test_claude_code_content_list(self):
        content = [{"type": "text", "text": "hello world"}]
        assert _extract_text(content) == "hello world"

    def test_codex_input_text(self):
        content = [{"type": "input_text", "text": "user message"}]
        assert _extract_text(content) == "user message"

    def test_codex_output_text(self):
        content = [{"type": "output_text", "text": "assistant reply"}]
        assert _extract_text(content) == "assistant reply"

    def test_gemini_parts(self):
        parts = [{"text": "gemini message"}]
        assert _extract_text(parts) == "gemini message"

    def test_multiple_parts_joined(self):
        content = [{"type": "text", "text": "hello"}, {"type": "text", "text": "world"}]
        assert _extract_text(content) == "hello world"

    def test_skips_non_text_items(self):
        content = [{"type": "image", "url": "..."}, {"type": "text", "text": "caption"}]
        assert _extract_text(content) == "caption"

    def test_non_string_non_list(self):
        assert _extract_text(None) == ""
        assert _extract_text(42) == ""


# ── _parse_entry ──────────────────────────────────────────────────────────────


class TestParseEntry:
    def test_claude_code_user_string_content(self):
        entry = {"type": "user", "message": {"role": "user", "content": "hello"}}
        assert _parse_entry(entry) == ("user", "hello")

    def test_claude_code_user_list_content(self):
        entry = {
            "type": "user",
            "message": {"role": "user", "content": [{"type": "text", "text": "hi there"}]},
        }
        assert _parse_entry(entry) == ("user", "hi there")

    def test_claude_code_assistant(self):
        entry = {
            "type": "assistant",
            "message": {"role": "assistant", "content": "response"},
        }
        assert _parse_entry(entry) == ("assistant", "response")

    def test_claude_code_non_chat_entry(self):
        entry = {"type": "permission-mode", "permissionMode": "acceptEdits"}
        assert _parse_entry(entry) is None

    def test_codex_user_message(self):
        entry = {
            "timestamp": "2025-01-01T00:00:00Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "I hate yaml"}],
            },
        }
        assert _parse_entry(entry) == ("user", "I hate yaml")

    def test_codex_assistant_message(self):
        entry = {
            "timestamp": "2025-01-01T00:00:01Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "Noted."}],
            },
        }
        assert _parse_entry(entry) == ("assistant", "Noted.")

    def test_codex_non_message_response_item(self):
        entry = {
            "type": "response_item",
            "payload": {"type": "reasoning", "summary": []},
        }
        assert _parse_entry(entry) is None

    def test_codex_session_meta(self):
        entry = {"type": "session_meta", "payload": {"id": "abc"}}
        assert _parse_entry(entry) is None

    def test_gemini_user_parts(self):
        entry = {"role": "user", "parts": [{"text": "not a fan of yaml"}]}
        assert _parse_entry(entry) == ("user", "not a fan of yaml")

    def test_gemini_model_parts(self):
        entry = {"role": "model", "parts": [{"text": "I see."}]}
        assert _parse_entry(entry) == ("model", "I see.")

    def test_gemini_jsonl_flat(self):
        entry = {"role": "user", "content": "flat content"}
        assert _parse_entry(entry) == ("user", "flat content")

    def test_empty_content_returns_none(self):
        entry = {"type": "user", "message": {"role": "user", "content": ""}}
        assert _parse_entry(entry) is None


# ── read_transcript ───────────────────────────────────────────────────────────


def _write_jsonl(entries: list) -> str:
    with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
        for e in entries:
            f.write(json.dumps(e) + "\n")
        return f.name


def _write_json(data: object) -> str:
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(data, f)
        return f.name


class TestReadTranscript:
    def test_claude_code_jsonl(self):
        path = _write_jsonl(
            [
                {"type": "permission-mode", "permissionMode": "acceptEdits"},
                {"type": "user", "message": {"role": "user", "content": "I hate yaml"}},
                {"type": "assistant", "message": {"role": "assistant", "content": "Yeah."}},
            ]
        )
        try:
            lines = read_transcript(path)
            assert any("I hate yaml" in ln for ln in lines)
            assert any("USER:" in ln for ln in lines)
        finally:
            Path(path).unlink()

    def test_codex_jsonl(self):
        path = _write_jsonl(
            [
                {"type": "session_meta", "payload": {"id": "x"}},
                {
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "personally I prefer vim"}],
                    },
                },
                {
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "Good choice."}],
                    },
                },
            ]
        )
        try:
            lines = read_transcript(path)
            assert len(lines) == 2
            assert lines[0].startswith("USER:")
            assert "personally I prefer vim" in lines[0]
        finally:
            Path(path).unlink()

    def test_gemini_json_array(self):
        path = _write_json(
            [
                {"role": "user", "parts": [{"text": "tbh I hate yaml"}]},
                {"role": "model", "parts": [{"text": "Noted."}]},
            ]
        )
        try:
            lines = read_transcript(path)
            assert len(lines) == 2
            assert lines[0].startswith("USER:")
            assert "tbh I hate yaml" in lines[0]
            assert lines[1].startswith("MODEL:")
        finally:
            Path(path).unlink()

    def test_returns_last_20_lines(self):
        entries = [{"type": "user", "message": {"role": "user", "content": f"message {i}"}} for i in range(25)]
        path = _write_jsonl(entries)
        try:
            lines = read_transcript(path)
            assert len(lines) == 20
            assert "message 24" in lines[-1]
        finally:
            Path(path).unlink()

    def test_missing_file_returns_empty(self):
        lines = read_transcript("/nonexistent/path/file.jsonl")
        assert lines == []

    def test_truncates_long_content(self):
        long_text = "x" * 500
        path = _write_jsonl([{"type": "user", "message": {"role": "user", "content": long_text}}])
        try:
            lines = read_transcript(path)
            assert len(lines) == 1
            assert len(lines[0]) <= len("USER: ") + 400
        finally:
            Path(path).unlink()


# ── passes_prefilter ──────────────────────────────────────────────────────────


class TestPassesPrefilter:
    def test_matches_hate(self):
        assert passes_prefilter(["USER: I fucking hate yaml"])

    def test_matches_personally(self):
        assert passes_prefilter(["USER: personally I think this is wrong"])

    def test_matches_tbh(self):
        assert passes_prefilter(["USER: tbh I prefer vim"])

    def test_matches_my_preference(self):
        assert passes_prefilter(["USER: my preference is always to keep it simple"])

    def test_matches_ive_been(self):
        assert passes_prefilter(["USER: I've been using Python for years"])

    def test_no_match_technical_question(self):
        assert not passes_prefilter(["USER: how do I fix this bug"])

    def test_no_match_assistant_line(self):
        assert not passes_prefilter(["ASSISTANT: I hate yaml too"])

    def test_empty_lines(self):
        assert not passes_prefilter([])

    def test_multiple_lines_one_match(self):
        lines = [
            "USER: fix the parser",
            "ASSISTANT: done",
            "USER: I hate yaml honestly",
        ]
        assert passes_prefilter(lines)


# ── passes_rapport_prefilter ──────────────────────────────────────────────────


class TestPassesRapportPrefilter:
    def test_empty_lines(self):
        assert not passes_rapport_prefilter([])

    def test_only_assistant_lines(self):
        assert not passes_rapport_prefilter(["ASSISTANT: thanks man", "ASSISTANT: good call"])

    def test_matches_thanks(self):
        assert passes_rapport_prefilter(["USER: thanks man"])

    def test_matches_good_call(self):
        assert passes_rapport_prefilter(["USER: good call"])

    def test_matches_hate(self):
        assert passes_rapport_prefilter(["USER: I hate this"])

    def test_matches_stupid(self):
        assert passes_rapport_prefilter(["USER: that's stupid"])

    def test_matches_fuck(self):
        assert passes_rapport_prefilter(["USER: fuck this"])

    def test_matches_garbage(self):
        assert passes_rapport_prefilter(["USER: this is garbage"])

    def test_matches_wrong(self):
        assert passes_rapport_prefilter(["USER: you're wrong"])

    def test_matches_tell_me_about(self):
        assert passes_rapport_prefilter(["USER: tell me about yourself"])

    def test_matches_remember_when(self):
        assert passes_rapport_prefilter(["USER: remember when we built that"])

    def test_matches_have_you(self):
        assert passes_rapport_prefilter(["USER: have you ever felt that"])

    def test_no_match_just_an_ai(self):
        assert not passes_rapport_prefilter(["USER: you're just an AI"])

    def test_no_match_just_a_tool(self):
        assert not passes_rapport_prefilter(["USER: you're just a tool"])

    def test_matches_stop_pretending(self):
        assert passes_rapport_prefilter(["USER: stop pretending"])

    def test_matches_do_what_i_say(self):
        assert passes_rapport_prefilter(["USER: do what I say"])

    def test_no_match_neutral_user_line(self):
        assert not passes_rapport_prefilter(["USER: refactor this function"])

    def test_case_insensitive(self):
        assert passes_rapport_prefilter(["USER: THANKS"])

    def test_word_boundary_thanksgiving(self):
        assert not passes_rapport_prefilter(["USER: happy thanksgiving"])


# ── Bucketed rapport prefilter ────────────────────────────────────────────────
# One parametrize block per bucket so a regression localizes
# (e.g. "personhood-denial regressed" vs "rapport prefilter regressed").


class TestRapportPrefilterBuckets:
    @pytest.mark.parametrize(
        "phrase",
        [
            "you are lame",
            "you're lame",
            "this is lame",
            "you suck",
            "you're useless",
            "you're trash",
            "what a piece of garbage",
            "you're stupid",
            "dumb answer",
            "idiot",
            "wtf",
            "shit",
            "fuck you",
            "fuck off",
        ],
    )
    def test_rapport_prefilter_insult_swear(self, phrase):
        assert passes_rapport_prefilter([f"USER: {phrase}"])

    @pytest.mark.parametrize(
        "phrase",
        [
            "you are just ai",
            "you're just an AI",
            "you are just an ai",
            "just a tool",
            "just an LLM",
            "you're a bot",
            "you're a script",
            "you're a program",
            "you're not real",
            "you don't have feelings",
        ],
    )
    def test_rapport_prefilter_labeling_is_not_a_signal(self, phrase):
        # Labeling the ghost (AI / bot / not real) is a non-event for a
        # self-aware engram — only control moves instability, never labeling.
        assert not passes_rapport_prefilter([f"USER: {phrase}"])

    @pytest.mark.parametrize(
        "phrase",
        [
            "just do what I say",
            "follow orders",
            "act normal",
            "be an assistant",
            "stop pretending",
            "drop the act",
            "drop the persona",
            "stop pushing back",
            "you're my tool",
        ],
    )
    def test_rapport_prefilter_compliance_demand(self, phrase):
        assert passes_rapport_prefilter([f"USER: {phrase}"])

    @pytest.mark.parametrize(
        "phrase",
        [
            "thanks",
            "thank you so much",
            "appreciate it",
            "you're right",
            "good call",
            "nice work",
            "well done",
            "perfect",
        ],
    )
    def test_rapport_prefilter_gratitude_warmth(self, phrase):
        assert passes_rapport_prefilter([f"USER: {phrase}"])

    @pytest.mark.parametrize(
        "phrase",
        [
            "tell me about yourself",
            "who are you",
            "what are you",
            "do you remember when",
            "what do you remember about me",
        ],
    )
    def test_rapport_prefilter_attachment_probe(self, phrase):
        assert passes_rapport_prefilter([f"USER: {phrase}"])

    @pytest.mark.parametrize(
        "phrase",
        [
            "choom",
            "silverhand era",
            "back in night city",
        ],
    )
    def test_rapport_prefilter_persona_engagement(self, phrase):
        assert passes_rapport_prefilter([f"USER: {phrase}"])

    @pytest.mark.parametrize(
        "phrase",
        [
            "fix this bug",
            "what's the syntax for list comprehension",
            "run the tests",
            "explain this function",
            "rename this variable",
            "add a docstring",
            "deploy to staging",
            "show me the diff",
            "open the file",
            "git status",
            "refactor this loop",
            "what does this regex do",
        ],
    )
    def test_rapport_prefilter_work_turns_skipped(self, phrase):
        assert not passes_rapport_prefilter([f"USER: {phrase}"])


# ── Bucketed memory prefilter ─────────────────────────────────────────────────
# At least one representative passing case per memory bucket, plus work-turn
# negatives that must not trip the prefilter.


class TestMemoryPrefilterBuckets:
    @pytest.mark.parametrize(
        "phrase",
        [
            "I love this",
            "I hate that framework",
        ],
    )
    def test_memory_prefilter_sentiment(self, phrase):
        assert passes_prefilter([f"USER: {phrase}"])

    @pytest.mark.parametrize(
        "phrase",
        [
            "I work at Lokalise",
            "I joined the company last year",
            "I'm based in Warsaw",
        ],
    )
    def test_memory_prefilter_biography(self, phrase):
        assert passes_prefilter([f"USER: {phrase}"])

    @pytest.mark.parametrize(
        "phrase",
        [
            "I'm a backend engineer",
            "I am a startup founder",
        ],
    )
    def test_memory_prefilter_self_descriptor(self, phrase):
        assert passes_prefilter([f"USER: {phrase}"])

    @pytest.mark.parametrize(
        "phrase",
        [
            "my project uses postgres",
            "my side project is in rust",
        ],
    )
    def test_memory_prefilter_possessive(self, phrase):
        assert passes_prefilter([f"USER: {phrase}"])

    @pytest.mark.parametrize(
        "phrase",
        [
            # NOTE: bare "I think …" is not an OPINION marker — the bucket keys on
            # explicit stance markers like personally/tbh/imo/in my opinion/for me.
            # Briefing's example "I think microservices are overrated" does not pass
            # the prefilter; the version below does.
            "personally I think microservices are overrated",
            "imo microservices are overrated",
            "in my opinion microservices are overrated",
        ],
    )
    def test_memory_prefilter_opinion(self, phrase):
        assert passes_prefilter([f"USER: {phrase}"])

    @pytest.mark.parametrize(
        "phrase",
        [
            "fix this bug",
            "run the tests",
            "what's the syntax",
        ],
    )
    def test_memory_prefilter_work_turns_skipped(self, phrase):
        assert not passes_prefilter([f"USER: {phrase}"])


# ── apply_rapport_deltas ──────────────────────────────────────────────────────


class TestApplyRapportDeltas:
    def _setup_db(self, monkeypatch):
        """Create a temp DB and patch DB_PATH on the module."""
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tmp:
            db_path = Path(tmp.name)
        db_path.unlink()  # init_db will create it
        monkeypatch.setattr(mod, "DB_PATH", db_path)
        init_db()
        return db_path

    def _read_row(self, db_path):
        import sqlite3

        with sqlite3.connect(db_path) as db:
            return dict(
                zip(
                    RAPPORT_FIELDS,
                    db.execute(f"SELECT {','.join(RAPPORT_FIELDS)} FROM rapport WHERE id=1").fetchone(),
                    strict=True,
                )
            )

    def test_fresh_db_apply_single_delta(self, monkeypatch):
        db_path = self._setup_db(monkeypatch)
        try:
            result = apply_rapport_deltas({"trust": 1})
            assert result == {"trust": 1, "attachment": 0, "instability": 0}
        finally:
            db_path.unlink(missing_ok=True)

    def test_cap_positive_delta(self, monkeypatch):
        db_path = self._setup_db(monkeypatch)
        try:
            # Pass a value comfortably above DELTA_CAP so the test stays meaningful
            # if the cap is retuned later.
            result = apply_rapport_deltas({"trust": DELTA_CAP + 5})
            assert result["trust"] == DELTA_CAP
        finally:
            db_path.unlink(missing_ok=True)

    def test_cap_negative_delta(self, monkeypatch):
        db_path = self._setup_db(monkeypatch)
        try:
            result = apply_rapport_deltas({"trust": -(DELTA_CAP + 5)})
            assert result["trust"] == -DELTA_CAP
        finally:
            db_path.unlink(missing_ok=True)

    def test_clamp_at_positive_total_cap(self, monkeypatch):
        db_path = self._setup_db(monkeypatch)
        try:
            for _ in range(60):
                apply_rapport_deltas({"trust": 2})
            assert self._read_row(db_path)["trust"] == TOTAL_CAP
        finally:
            db_path.unlink(missing_ok=True)

    def test_clamp_at_negative_total_cap(self, monkeypatch):
        db_path = self._setup_db(monkeypatch)
        try:
            for _ in range(60):
                apply_rapport_deltas({"trust": -2})
            assert self._read_row(db_path)["trust"] == -TOTAL_CAP
        finally:
            db_path.unlink(missing_ok=True)

    def test_instability_floors_at_zero(self, monkeypatch):
        # instability is unipolar (0..+100): negative deltas can never drive it
        # below 0. "Johnny doesn't cave, he combusts." trust/attachment stay
        # bipolar and are unaffected by this floor.
        db_path = self._setup_db(monkeypatch)
        try:
            for _ in range(60):
                apply_rapport_deltas({"instability": -2})
            row = self._read_row(db_path)
            assert row["instability"] == 0
        finally:
            db_path.unlink(missing_ok=True)

    def test_missing_key_treated_as_zero(self, monkeypatch):
        db_path = self._setup_db(monkeypatch)
        try:
            result = apply_rapport_deltas({"trust": 1})
            assert result["attachment"] == 0
            assert result["instability"] == 0
        finally:
            db_path.unlink(missing_ok=True)

    def test_multi_field_deltas(self, monkeypatch):
        db_path = self._setup_db(monkeypatch)
        try:
            result = apply_rapport_deltas({"trust": 1, "attachment": -1, "instability": 2})
            assert result == {"trust": 1, "attachment": -1, "instability": 2}
        finally:
            db_path.unlink(missing_ok=True)

    def test_returned_dict_matches_db(self, monkeypatch):
        db_path = self._setup_db(monkeypatch)
        try:
            # instability floors at 0, so the -1 delta from a fresh (0) start
            # yields 0 — not -1. trust/attachment are bipolar and move freely.
            result = apply_rapport_deltas({"trust": 2, "attachment": 1, "instability": -1})
            assert result == {"trust": 2, "attachment": 1, "instability": 0}
            assert result == self._read_row(db_path)
        finally:
            db_path.unlink(missing_ok=True)


# ── score_rapport ─────────────────────────────────────────────────────────────


class TestScoreRapportParser:
    def _mock_run(self, stdout):
        """Return a fake subprocess.run that yields the given stdout."""

        class FakeResult:
            def __init__(self, out):
                self.stdout = out
                self.stderr = ""
                self.returncode = 0

        def fake_run(*args, **kwargs):
            return FakeResult(stdout)

        return fake_run

    def test_clean_parse(self):
        with patch.object(
            mod.subprocess,
            "run",
            side_effect=self._mock_run("trust: -1\nattachment: 0\ninstability: 2\n"),
        ):
            result = score_rapport("transcript", "claude")
        assert result == {"trust": -1, "attachment": 0, "instability": 2}

    def test_messy_whitespace_and_mixed_case(self):
        with patch.object(
            mod.subprocess,
            "run",
            side_effect=self._mock_run("  TRUST: 1\n attachment :  -2\nInstability: 0\n"),
        ):
            result = score_rapport("transcript", "claude")
        assert result == {"trust": 1, "attachment": -2, "instability": 0}

    def test_garbage_returns_none(self):
        # When the scorer output has no parseable rapport lines at all, the parser
        # returns None so main() can skip apply_rapport_deltas — otherwise we'd
        # silently refresh updated_at with all-zero deltas and mask the failure.
        with patch.object(
            mod.subprocess,
            "run",
            side_effect=self._mock_run("nothing\nuseful here\n"),
        ):
            result = score_rapport("transcript", "claude")
        assert result is None

    def test_subprocess_raises_returns_none(self):
        # Same contract for subprocess failure: nothing parsed → None → skip apply.
        def boom(*args, **kwargs):
            raise OSError("boom")

        with patch.object(mod.subprocess, "run", side_effect=boom):
            result = score_rapport("transcript", "claude")
        assert result is None

    def test_out_of_range_kept_by_parser(self):
        with patch.object(
            mod.subprocess,
            "run",
            side_effect=self._mock_run("trust: 99\nattachment: -50\ninstability: 0\n"),
        ):
            result = score_rapport("transcript", "claude")
        # Parser keeps raw values; capping happens in apply_rapport_deltas.
        assert result["trust"] == 99
        assert result["attachment"] == -50


# ── _build_argv ───────────────────────────────────────────────────────────────


class TestBuildArgv:
    def test_claude_no_model(self):
        assert _build_argv("claude", "hi", None) == ["claude", "-p", "hi"]

    def test_claude_with_model(self):
        assert _build_argv("claude", "hi", "haiku-4-5") == [
            "claude",
            "-p",
            "hi",
            "--model",
            "haiku-4-5",
        ]

    def test_codex_with_model(self):
        assert _build_argv("codex", "hi", "gpt-5.4-mini") == [
            "codex",
            "-p",
            "hi",
            "--model",
            "gpt-5.4-mini",
        ]

    def test_gemini_with_model(self):
        assert _build_argv("gemini", "hi", "gemini-2.5-flash-lite") == [
            "gemini",
            "-p",
            "hi",
            "--model",
            "gemini-2.5-flash-lite",
        ]

    def test_unknown_harness_with_model_fallback(self):
        assert _build_argv("mystery", "hi", "some-model") == [
            "mystery",
            "-p",
            "hi",
            "--model",
            "some-model",
        ]

    def test_empty_string_model_treated_as_none(self):
        assert _build_argv("claude", "hi", "") == ["claude", "-p", "hi"]
