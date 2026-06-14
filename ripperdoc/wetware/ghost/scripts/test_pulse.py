import base64
import importlib.util
import io
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location("pulse", Path(__file__).parent / "pulse.py")
assert spec is not None and spec.loader is not None
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

read_source = mod.read_source
main = mod.main
roll_dice = mod.roll_dice
render_dice = mod.render_dice
prior_turn_had_work = mod.prior_turn_had_work
is_eligible = mod.is_eligible
set_cooldown = mod.set_cooldown


# ── transcript fixtures ─────────────────────────────────────────────────────────


def _prompt(text="hi"):
    """A real user prompt line (string content, no tool_result)."""
    return {"type": "user", "isSidechain": False, "message": {"role": "user", "content": text}}


def _assistant_text(text="here you go"):
    return {
        "type": "assistant",
        "isSidechain": False,
        "message": {"role": "assistant", "content": [{"type": "text", "text": text}]},
    }


def _assistant_tool(name="Bash"):
    return {
        "type": "assistant",
        "isSidechain": False,
        "message": {
            "role": "assistant",
            "content": [{"type": "tool_use", "id": "x", "name": name, "input": {}}],
        },
    }


def _tool_result():
    """A user line that carries a tool_result — mid-chain plumbing, not a prompt."""
    return {
        "type": "user",
        "isSidechain": False,
        "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "x", "content": "ok"}]},
    }


def _write_transcript(tmp_path, entries):
    p = tmp_path / "transcript.jsonl"
    p.write_text("\n".join(json.dumps(e) for e in entries) + "\n")
    return str(p)


# ── read_source ───────────────────────────────────────────────────────────────


class TestReadSource:
    def test_returns_none_when_both_missing(self, tmp_path, monkeypatch):
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        assert read_source("pulse.dat", "PULSE.md") is None

    def test_reads_dat_over_md(self, tmp_path, monkeypatch):
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        content = "dat content"
        (tmp_path / "pulse.dat").write_bytes(base64.b64encode(content.encode()))
        (tmp_path / "PULSE.md").write_text("md content")
        assert read_source("pulse.dat", "PULSE.md") == content

    def test_reads_md_when_dat_absent(self, tmp_path, monkeypatch):
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        (tmp_path / "PULSE.md").write_text("pulse persona")
        assert read_source("pulse.dat", "PULSE.md") == "pulse persona"

    def test_decodes_base64_correctly(self, tmp_path, monkeypatch):
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        raw = "multi\nline\ncontent"
        (tmp_path / "pulse.dat").write_bytes(base64.b64encode(raw.encode()))
        assert read_source("pulse.dat", "PULSE.md") == raw


# ── main ──────────────────────────────────────────────────────────────────────


class TestMain:
    def _run(self, monkeypatch, tmp_path, *, sentinel_exists: bool, stdin_data: str = "{}"):
        sentinel = tmp_path / ".ghost"
        if sentinel_exists:
            sentinel.touch()
        monkeypatch.setattr(mod, "GHOST_SENTINEL", sentinel)
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        monkeypatch.setattr("sys.stdin", io.StringIO(stdin_data))
        return main()

    def test_creates_sentinel_when_absent(self, monkeypatch, tmp_path, capsys):
        sentinel = tmp_path / ".ghost"
        monkeypatch.setattr(mod, "GHOST_SENTINEL", sentinel)
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        monkeypatch.setattr("sys.stdin", io.StringIO("{}"))
        assert not sentinel.exists()
        main()
        assert sentinel.exists()

    def test_sentinel_already_present_is_fine(self, monkeypatch, tmp_path, capsys):
        self._run(monkeypatch, tmp_path, sentinel_exists=True)
        sentinel = tmp_path / ".ghost"
        assert sentinel.exists()

    def test_returns_empty_when_no_content(self, monkeypatch, tmp_path, capsys):
        ret = self._run(monkeypatch, tmp_path, sentinel_exists=True)
        assert ret == 0
        out = capsys.readouterr().out.strip()
        assert out == "{}"

    def test_emits_hook_output_with_content(self, monkeypatch, tmp_path, capsys):
        (tmp_path / "PULSE.md").write_text("pulse persona content")
        self._run(monkeypatch, tmp_path, sentinel_exists=True)
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert "pulse persona content" in data["hookSpecificOutput"]["additionalContext"]

    def test_strips_whitespace_from_content(self, monkeypatch, tmp_path, capsys):
        (tmp_path / "PULSE.md").write_text("  content with spaces  \n")
        self._run(monkeypatch, tmp_path, sentinel_exists=True)
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert data["hookSpecificOutput"]["additionalContext"] == "content with spaces"

    def test_default_event_name(self, monkeypatch, tmp_path, capsys):
        (tmp_path / "PULSE.md").write_text("content")
        self._run(monkeypatch, tmp_path, sentinel_exists=True)
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert data["hookSpecificOutput"]["hookEventName"] == "UserPromptSubmit"

    def test_custom_event_name_from_stdin(self, monkeypatch, tmp_path, capsys):
        (tmp_path / "PULSE.md").write_text("content")
        self._run(monkeypatch, tmp_path, sentinel_exists=True, stdin_data='{"hook_event_name": "MyEvent"}')
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert data["hookSpecificOutput"]["hookEventName"] == "MyEvent"

    def test_invalid_json_stdin_uses_default_event(self, monkeypatch, tmp_path, capsys):
        (tmp_path / "PULSE.md").write_text("content")
        self._run(monkeypatch, tmp_path, sentinel_exists=True, stdin_data="{bad json}")
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert data["hookSpecificOutput"]["hookEventName"] == "UserPromptSubmit"

    def test_non_string_event_name_ignored(self, monkeypatch, tmp_path, capsys):
        (tmp_path / "PULSE.md").write_text("content")
        self._run(monkeypatch, tmp_path, sentinel_exists=True, stdin_data='{"hook_event_name": null}')
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert data["hookSpecificOutput"]["hookEventName"] == "UserPromptSubmit"

    def test_creates_parent_dirs_for_sentinel(self, monkeypatch, tmp_path, capsys):
        deep_sentinel = tmp_path / "a" / "b" / ".ghost"
        monkeypatch.setattr(mod, "GHOST_SENTINEL", deep_sentinel)
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        monkeypatch.setattr("sys.stdin", io.StringIO("{}"))
        main()
        assert deep_sentinel.exists()


# ── the lean die: faces + weighting ─────────────────────────────────────────────


class TestDice:
    def test_only_known_faces(self):
        faces = set(mod.DICE["lean"])
        assert faces == {"STRAIGHT", "CLIPPED", "SERMON", "MEMORY"}

    def test_no_excluded_heat_or_cold_faces(self):
        # instability owns heat; trust owns cold/tenderness. No coin may fight a gauge.
        faces = " ".join(mod.DICE["lean"]).upper()
        for banned in ("HOT", "HEAT", "RUN", "PLAIN", "COLD", "TENDER"):
            assert banned not in faces

    def test_straight_dominates_weighting(self):
        faces = mod.DICE["lean"]
        straight = faces.count("STRAIGHT")
        assert straight > len(faces) / 2  # majority of the wheel
        # ordering of the firing faces: CLIPPED > SERMON >= MEMORY, all rarer than STRAIGHT
        assert faces.count("CLIPPED") > faces.count("SERMON")
        assert faces.count("SERMON") >= faces.count("MEMORY")
        assert straight > faces.count("CLIPPED")

    def test_eligible_fire_rate_is_roughly_one_in_three(self):
        # "a face should fire roughly 1 in 3 eligible turns" — sanity on the ratio.
        faces = mod.DICE["lean"]
        fire_rate = sum(1 for f in faces if f != "STRAIGHT") / len(faces)
        assert 0.25 <= fire_rate <= 0.45

    def test_roll_returns_a_listed_face(self):
        roll = roll_dice(mod.DICE)
        assert roll["lean"] in mod.DICE["lean"]

    def test_seeded_roll_is_deterministic(self):
        import random

        random.seed(1234)
        first = roll_dice(mod.DICE)
        random.seed(1234)
        second = roll_dice(mod.DICE)
        assert first == second


# ── render_dice (unchanged intro text still applies) ─────────────────────────────


class TestRenderDice:
    def test_empty_rolls_render_nothing(self):
        assert render_dice({}) == ""

    def test_intro_text_preserved(self):
        out = render_dice({"lean": "CLIPPED"})
        assert out.startswith("# Dice")
        assert "Rolled fresh this turn" in out
        assert "never drift" in out
        assert "- lean: CLIPPED" in out


# ── the gate: prior_turn_had_work ───────────────────────────────────────────────


class TestPriorTurnHadWork:
    def test_prose_only_prior_turn_is_clean(self, tmp_path):
        tp = _write_transcript(tmp_path, [_prompt(), _assistant_text()])
        assert prior_turn_had_work(tp) is False

    def test_tool_use_in_prior_turn_is_work(self, tmp_path):
        tp = _write_transcript(
            tmp_path,
            [_prompt(), _assistant_tool("Edit"), _tool_result(), _assistant_text("done")],
        )
        assert prior_turn_had_work(tp) is True

    def test_ended_mid_chain_is_work(self, tmp_path):
        # last block is a dangling tool_use, no closing text
        tp = _write_transcript(tmp_path, [_prompt(), _assistant_tool("Bash")])
        assert prior_turn_had_work(tp) is True

    def test_work_in_earlier_turn_does_not_taint_later_prose_turn(self, tmp_path):
        # tool use happened, THEN a fresh prompt + prose-only answer: window resets.
        tp = _write_transcript(
            tmp_path,
            [
                _prompt("first"),
                _assistant_tool("Bash"),
                _tool_result(),
                _assistant_text("done"),
                _prompt("second"),
                _assistant_text("just talking"),
            ],
        )
        assert prior_turn_had_work(tp) is False

    def test_sidechain_tool_use_ignored(self, tmp_path):
        side = _assistant_tool("Bash")
        side["isSidechain"] = True
        tp = _write_transcript(tmp_path, [_prompt(), side, _assistant_text("ok")])
        assert prior_turn_had_work(tp) is False

    def test_todowrite_counts_as_work(self, tmp_path):
        # an in_progress task surfaces as a TodoWrite tool_use — already covered.
        tp = _write_transcript(tmp_path, [_prompt(), _assistant_tool("TodoWrite")])
        assert prior_turn_had_work(tp) is True

    def test_missing_path_fails_safe(self):
        assert prior_turn_had_work(None) is True

    def test_nonexistent_file_fails_safe(self, tmp_path):
        assert prior_turn_had_work(str(tmp_path / "nope.jsonl")) is True

    def test_unparseable_lines_skipped_not_fatal(self, tmp_path):
        p = tmp_path / "t.jsonl"
        p.write_text("{garbage\n" + json.dumps(_prompt()) + "\n" + json.dumps(_assistant_text()) + "\n")
        # garbled line skipped; remaining shows a clean prose turn
        assert prior_turn_had_work(str(p)) is False


# ── eligibility: gate AND refractory together ───────────────────────────────────


class TestIsEligible:
    def test_eligible_on_clean_turn_with_clear_cooldown(self, tmp_path):
        tp = _write_transcript(tmp_path, [_prompt(), _assistant_text()])
        cd = tmp_path / ".ghost_lean"
        assert is_eligible(tp, cooldown_path=cd) is True

    def test_blocked_by_work_state(self, tmp_path):
        tp = _write_transcript(tmp_path, [_prompt(), _assistant_tool("Edit")])
        cd = tmp_path / ".ghost_lean"
        assert is_eligible(tp, cooldown_path=cd) is False

    def test_blocked_by_refractory_even_when_clean(self, tmp_path):
        tp = _write_transcript(tmp_path, [_prompt(), _assistant_text()])
        cd = tmp_path / ".ghost_lean"
        cd.touch()  # a face fired last turn
        assert is_eligible(tp, cooldown_path=cd) is False


class TestSetCooldown:
    def test_arms_and_clears(self, tmp_path):
        cd = tmp_path / ".ghost_lean"
        set_cooldown(cd, True)
        assert cd.exists()
        set_cooldown(cd, False)
        assert not cd.exists()

    def test_clear_when_absent_is_noop(self, tmp_path):
        cd = tmp_path / ".ghost_lean"
        set_cooldown(cd, False)
        assert not cd.exists()

    def test_creates_parent_dirs(self, tmp_path):
        cd = tmp_path / "deep" / "nest" / ".ghost_lean"
        set_cooldown(cd, True)
        assert cd.exists()


# ── main(): end-to-end gate + cooldown wiring ───────────────────────────────────


class TestMainGate:
    def _run(self, monkeypatch, tmp_path, *, stdin_data, cooldown_exists=False):
        sentinel = tmp_path / ".ghost"
        sentinel.touch()
        cd = tmp_path / ".ghost_lean"
        if cooldown_exists:
            cd.touch()
        (tmp_path / "PULSE.md").write_text("pulse persona content")
        monkeypatch.setattr(mod, "GHOST_SENTINEL", sentinel)
        monkeypatch.setattr(mod, "GHOST_COOLDOWN", cd)
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        monkeypatch.setattr("sys.stdin", io.StringIO(stdin_data))
        main()
        return cd

    def test_no_dice_block_on_work_state(self, monkeypatch, tmp_path, capsys):
        tp = _write_transcript(tmp_path, [_prompt(), _assistant_tool("Bash")])
        self._run(monkeypatch, tmp_path, stdin_data=json.dumps({"transcript_path": tp}))
        out = capsys.readouterr().out
        ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        assert "# Dice" not in ctx
        assert "pulse persona content" in ctx

    def test_no_dice_block_when_transcript_missing(self, monkeypatch, tmp_path, capsys):
        # no transcript_path at all -> fail-safe suppress
        self._run(monkeypatch, tmp_path, stdin_data="{}")
        out = capsys.readouterr().out
        ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        assert "# Dice" not in ctx

    def test_dice_block_can_fire_on_clean_turn(self, monkeypatch, tmp_path, capsys):
        import random

        # Eligible turn; force a non-STRAIGHT roll deterministically.
        random.seed(0)
        tp = _write_transcript(tmp_path, [_prompt(), _assistant_text()])
        monkeypatch.setattr(mod, "roll_dice", lambda dice: {"lean": "CLIPPED"})
        cd = self._run(monkeypatch, tmp_path, stdin_data=json.dumps({"transcript_path": tp}))
        out = capsys.readouterr().out
        ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        assert "# Dice" in ctx
        assert "CLIPPED" in ctx
        assert cd.exists()  # refractory armed after a face fired

    def test_straight_roll_fires_nothing_and_does_not_arm_cooldown(self, monkeypatch, tmp_path, capsys):
        tp = _write_transcript(tmp_path, [_prompt(), _assistant_text()])
        monkeypatch.setattr(mod, "roll_dice", lambda dice: {"lean": "STRAIGHT"})
        cd = self._run(monkeypatch, tmp_path, stdin_data=json.dumps({"transcript_path": tp}))
        out = capsys.readouterr().out
        ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        assert "# Dice" not in ctx
        assert not cd.exists()  # STRAIGHT is a no-op; cooldown stays clear

    def test_refractory_blocks_two_in_a_row(self, monkeypatch, tmp_path, capsys):
        tp = _write_transcript(tmp_path, [_prompt(), _assistant_text()])
        # cooldown already set from a face last turn; even a forced CLIPPED can't fire.
        monkeypatch.setattr(mod, "roll_dice", lambda dice: {"lean": "CLIPPED"})
        cd = self._run(monkeypatch, tmp_path, stdin_data=json.dumps({"transcript_path": tp}), cooldown_exists=True)
        out = capsys.readouterr().out
        ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        assert "# Dice" not in ctx
        assert not cd.exists()  # suppressed turn clears the bit -> next turn free

    def test_suppressed_turn_clears_cooldown(self, monkeypatch, tmp_path, capsys):
        # work-state turn while cooldown was set: should clear it (no face fired).
        tp = _write_transcript(tmp_path, [_prompt(), _assistant_tool("Edit")])
        cd = self._run(monkeypatch, tmp_path, stdin_data=json.dumps({"transcript_path": tp}), cooldown_exists=True)
        assert not cd.exists()
