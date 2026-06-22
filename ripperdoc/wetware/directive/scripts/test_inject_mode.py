import importlib.util
import io
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location("inject_mode", Path(__file__).parent / "inject_mode.py")
assert spec is not None and spec.loader is not None
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

find_config = mod.find_config
select_variants = mod.select_variants
load_mode_text = mod.load_mode_text
main = mod.main


def _write_skill(skills_dir, name, body):
    """Create skills/<name>/directive.md (the prose the hook injects)."""
    d = skills_dir / name
    d.mkdir(parents=True)
    (d / "directive.md").write_text(f"{body}\n")


# ── find_config (OS-agnostic upward walk) ───────────────────────────────────────


class TestFindConfig:
    def test_returns_none_when_absent(self, tmp_path):
        assert find_config(tmp_path) is None

    def test_finds_in_start_dir(self, tmp_path):
        cfg = tmp_path / "preemdeck.json"
        cfg.write_text("{}")
        assert find_config(tmp_path) == cfg

    def test_walks_up_to_ancestor(self, tmp_path):
        cfg = tmp_path / "preemdeck.json"
        cfg.write_text("{}")
        nested = tmp_path / "plugins" / "cache" / "directive" / "scripts"
        nested.mkdir(parents=True)
        assert find_config(nested) == cfg

    def test_nearest_ancestor_wins(self, tmp_path):
        (tmp_path / "preemdeck.json").write_text('{"loc": "far"}')
        near_dir = tmp_path / "a" / "b"
        near_dir.mkdir(parents=True)
        near = near_dir / "preemdeck.json"
        near.write_text('{"loc": "near"}')
        assert find_config(near_dir) == near


# ── select_variants (directive object → active values) ───────────────────────────


class TestSelectVariants:
    def _cfg(self, tmp_path, text):
        p = tmp_path / "preemdeck.json"
        p.write_text(text)
        return p

    def test_object_values_in_slot_order(self, tmp_path):
        cfg = self._cfg(tmp_path, '{"directive": {"strategy": "swarm", "discretion": "auto"}}')
        assert select_variants(cfg) == ["swarm", "auto"]

    def test_bare_string_is_single_value(self, tmp_path):
        assert select_variants(self._cfg(tmp_path, '{"directive": "swarm"}')) == ["swarm"]

    def test_empty_when_field_missing(self, tmp_path):
        assert select_variants(self._cfg(tmp_path, '{"other": "x"}')) == []

    def test_empty_when_malformed(self, tmp_path):
        assert select_variants(self._cfg(tmp_path, "{bad json")) == []

    def test_empty_when_field_wrong_type(self, tmp_path):
        assert select_variants(self._cfg(tmp_path, '{"directive": 42}')) == []

    def test_empty_object_yields_nothing(self, tmp_path):
        assert select_variants(self._cfg(tmp_path, '{"directive": {}}')) == []

    def test_filters_blank_and_nonstring_and_dedupes(self, tmp_path):
        cfg = self._cfg(tmp_path, '{"directive": {"a": "swarm", "b": "", "c": 5, "d": "swarm"}}')
        assert select_variants(cfg) == ["swarm"]


# ── load_mode_text (skills/<value>/directive.md) ─────────────────────────────────


class TestLoadModeText:
    def _skills(self, tmp_path, monkeypatch):
        d = tmp_path / "skills"
        d.mkdir()
        monkeypatch.setattr(mod, "SKILLS_DIR", d)
        return d

    def test_loads_directive_body(self, tmp_path, monkeypatch):
        d = self._skills(tmp_path, monkeypatch)
        _write_skill(d, "swarm", "swarm body")
        assert load_mode_text("swarm") == "swarm body"

    def test_none_for_unknown(self, tmp_path, monkeypatch):
        self._skills(tmp_path, monkeypatch)
        assert load_mode_text("nope") is None

    def test_none_for_empty_body(self, tmp_path, monkeypatch):
        d = self._skills(tmp_path, monkeypatch)
        _write_skill(d, "blank", "   ")
        assert load_mode_text("blank") is None

    def test_rejects_path_traversal(self, tmp_path, monkeypatch):
        self._skills(tmp_path, monkeypatch)
        outside = tmp_path / "secret"
        outside.mkdir()
        (outside / "directive.md").write_text("secret")
        assert load_mode_text("../secret") is None


# ── main (config → directive object → concatenated directive bodies) ─────────────


class TestMain:
    def _setup(self, monkeypatch, tmp_path, *, config_text=None, skills=None):
        if config_text is not None:
            (tmp_path / "preemdeck.json").write_text(config_text)
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        for name, body in (skills or {}).items():
            _write_skill(skills_dir, name, body)
        monkeypatch.setattr(mod, "SEARCH_START", tmp_path)
        monkeypatch.setattr(mod, "SKILLS_DIR", skills_dir)

    def _run(self, monkeypatch, *, stdin_data="{}", argv=None):
        monkeypatch.setattr("sys.argv", ["inject_mode.py", *(argv or [])])
        monkeypatch.setattr("sys.stdin", io.StringIO(stdin_data))
        return main()

    def _context(self, capsys):
        return json.loads(capsys.readouterr().out.strip())["hookSpecificOutput"]["additionalContext"]

    def test_no_config_is_noop(self, monkeypatch, tmp_path, capsys):
        self._setup(monkeypatch, tmp_path)
        assert self._run(monkeypatch) == 0
        assert capsys.readouterr().out.strip() == "{}"

    def test_concatenates_slots_in_order(self, monkeypatch, tmp_path, capsys):
        self._setup(
            monkeypatch,
            tmp_path,
            config_text='{"directive": {"strategy": "swarm", "discretion": "auto"}}',
            skills={"swarm": "swarm body", "auto": "auto body", "ask": "ask body"},
        )
        self._run(monkeypatch)
        assert self._context(capsys) == "swarm body\n\nauto body"

    def test_bare_string_routes_single(self, monkeypatch, tmp_path, capsys):
        self._setup(
            monkeypatch,
            tmp_path,
            config_text='{"directive": "swarm"}',
            skills={"swarm": "swarm body", "auto": "auto body"},
        )
        self._run(monkeypatch)
        assert self._context(capsys) == "swarm body"

    def test_unknown_value_is_skipped(self, monkeypatch, tmp_path, capsys):
        self._setup(
            monkeypatch,
            tmp_path,
            config_text='{"directive": {"strategy": "swarm", "discretion": "nope"}}',
            skills={"swarm": "swarm body"},
        )
        self._run(monkeypatch)
        assert self._context(capsys) == "swarm body"

    def test_all_unknown_is_noop(self, monkeypatch, tmp_path, capsys):
        self._setup(
            monkeypatch,
            tmp_path,
            config_text='{"directive": {"strategy": "nope"}}',
            skills={"swarm": "swarm body"},
        )
        self._run(monkeypatch)
        assert capsys.readouterr().out.strip() == "{}"

    def test_empty_object_is_noop(self, monkeypatch, tmp_path, capsys):
        self._setup(
            monkeypatch,
            tmp_path,
            config_text='{"directive": {}}',
            skills={"swarm": "swarm body"},
        )
        self._run(monkeypatch)
        assert capsys.readouterr().out.strip() == "{}"

    def test_event_flag_fallback(self, monkeypatch, tmp_path, capsys):
        self._setup(
            monkeypatch,
            tmp_path,
            config_text='{"directive": {"strategy": "swarm"}}',
            skills={"swarm": "swarm body"},
        )
        self._run(monkeypatch, argv=["--event", "BeforeAgent"])
        data = json.loads(capsys.readouterr().out.strip())
        assert data["hookSpecificOutput"]["hookEventName"] == "BeforeAgent"

    def test_stdin_event_overrides_flag(self, monkeypatch, tmp_path, capsys):
        self._setup(
            monkeypatch,
            tmp_path,
            config_text='{"directive": {"strategy": "swarm"}}',
            skills={"swarm": "swarm body"},
        )
        self._run(
            monkeypatch,
            stdin_data='{"hook_event_name": "FromStdin"}',
            argv=["--event", "BeforeAgent"],
        )
        data = json.loads(capsys.readouterr().out.strip())
        assert data["hookSpecificOutput"]["hookEventName"] == "FromStdin"
