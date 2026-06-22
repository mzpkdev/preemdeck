import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location("set_mode", Path(__file__).parent / "set_mode.py")
assert spec is not None and spec.loader is not None
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

available_modes = mod.available_modes
config_slots = mod.config_slots
set_directive = mod.set_directive
main = mod.main


def _write_skill(skills_dir, name):
    """Create skills/<name>/ with a directive.md (the marker of a real mode)."""
    d = skills_dir / name
    d.mkdir(parents=True)
    (d / "directive.md").write_text("body\n")


# ── available_modes (skill folders that ship a directive.md) ─────────────────────


class TestAvailableModes:
    def test_lists_skills_with_directive_md(self, tmp_path, monkeypatch):
        d = tmp_path / "skills"
        d.mkdir()
        for n in ("swarm", "ask"):
            _write_skill(d, n)
        monkeypatch.setattr(mod, "SKILLS_DIR", d)
        assert available_modes() == ["ask", "swarm"]

    def test_empty_when_no_dir(self, tmp_path, monkeypatch):
        monkeypatch.setattr(mod, "SKILLS_DIR", tmp_path / "nope")
        assert available_modes() == []

    def test_ignores_dirs_without_directive_md(self, tmp_path, monkeypatch):
        d = tmp_path / "skills"
        d.mkdir()
        _write_skill(d, "swarm")
        (d / "setter-only").mkdir()  # no directive.md
        monkeypatch.setattr(mod, "SKILLS_DIR", d)
        assert available_modes() == ["swarm"]


# ── config_slots (slots already defined in the directive object) ─────────────────


class TestConfigSlots:
    def _cfg(self, tmp_path, text):
        p = tmp_path / "preemdeck.json"
        p.write_text(text)
        return p

    def test_lists_object_keys(self, tmp_path):
        cfg = self._cfg(tmp_path, '{"directive": {"strategy": "x", "discretion": "y"}}')
        assert config_slots(cfg) == ["strategy", "discretion"]

    def test_empty_when_missing(self, tmp_path):
        assert config_slots(self._cfg(tmp_path, '{"other": 1}')) == []

    def test_empty_when_legacy_string(self, tmp_path):
        assert config_slots(self._cfg(tmp_path, '{"directive": "swarm"}')) == []

    def test_empty_when_malformed(self, tmp_path):
        assert config_slots(self._cfg(tmp_path, "{bad")) == []


# ── set_directive (atomic, slot- and key-preserving write) ───────────────────────


class TestSetDirective:
    def test_sets_slot_and_preserves_others(self, tmp_path):
        cfg = tmp_path / "preemdeck.json"
        cfg.write_text('{\n  "directive": {"strategy": "", "discretion": "ask"},\n  "other": 1\n}\n')
        set_directive(cfg, "strategy", "swarm")
        assert json.loads(cfg.read_text()) == {
            "directive": {"strategy": "swarm", "discretion": "ask"},
            "other": 1,
        }

    def test_creates_object_when_missing(self, tmp_path):
        cfg = tmp_path / "preemdeck.json"
        cfg.write_text('{"keep": true}')
        set_directive(cfg, "strategy", "swarm")
        assert json.loads(cfg.read_text()) == {"keep": True, "directive": {"strategy": "swarm"}}

    def test_adds_new_slot_preserving_existing(self, tmp_path):
        cfg = tmp_path / "preemdeck.json"
        cfg.write_text('{"directive": {"strategy": "swarm"}}')
        set_directive(cfg, "discretion", "auto")
        assert json.loads(cfg.read_text()) == {"directive": {"strategy": "swarm", "discretion": "auto"}}

    def test_fixed_two_space_framing_with_trailing_newline(self, tmp_path):
        cfg = tmp_path / "preemdeck.json"
        cfg.write_text("{}")
        set_directive(cfg, "strategy", "swarm")
        assert cfg.read_text() == '{\n  "directive": {\n    "strategy": "swarm"\n  }\n}\n'

    def test_idempotent(self, tmp_path):
        cfg = tmp_path / "preemdeck.json"
        cfg.write_text('{"directive": {"strategy": "swarm"}}')
        set_directive(cfg, "strategy", "swarm")
        first = cfg.read_text()
        set_directive(cfg, "strategy", "swarm")
        assert cfg.read_text() == first

    def test_leaves_no_tmp_behind(self, tmp_path):
        cfg = tmp_path / "preemdeck.json"
        cfg.write_text("{}")
        set_directive(cfg, "strategy", "swarm")
        assert list(tmp_path.glob("*.tmp")) == []


# ── main (validation + exit codes) ───────────────────────────────────────────────


class TestMain:
    def _setup(self, monkeypatch, tmp_path, *, config_text='{"directive": {"strategy": "", "discretion": ""}}'):
        d = tmp_path / "skills"
        d.mkdir()
        for n in ("swarm", "ask", "auto"):
            _write_skill(d, n)
        monkeypatch.setattr(mod, "SKILLS_DIR", d)
        monkeypatch.setattr(mod, "SEARCH_START", tmp_path)
        if config_text is not None:
            (tmp_path / "preemdeck.json").write_text(config_text)
        return tmp_path / "preemdeck.json"

    def test_valid_sets_slot_and_returns_0(self, monkeypatch, tmp_path):
        cfg = self._setup(monkeypatch, tmp_path)
        assert main(["strategy", "swarm"]) == 0
        assert json.loads(cfg.read_text())["directive"] == {"strategy": "swarm", "discretion": ""}

    def test_unknown_value_returns_2_without_writing(self, monkeypatch, tmp_path, capsys):
        cfg = self._setup(monkeypatch, tmp_path)
        assert main(["strategy", "bogus"]) == 2
        assert json.loads(cfg.read_text())["directive"]["strategy"] == ""
        assert "value" in capsys.readouterr().err

    def test_unknown_slot_returns_2_without_writing(self, monkeypatch, tmp_path, capsys):
        cfg = self._setup(monkeypatch, tmp_path)
        assert main(["bogus", "swarm"]) == 2
        assert "bogus" not in json.loads(cfg.read_text())["directive"]
        assert "slot" in capsys.readouterr().err

    def test_wrong_arg_count_returns_2(self, monkeypatch, tmp_path):
        self._setup(monkeypatch, tmp_path)
        assert main([]) == 2
        assert main(["strategy"]) == 2
        assert main(["strategy", "swarm", "extra"]) == 2

    def test_blank_arg_returns_2(self, monkeypatch, tmp_path):
        self._setup(monkeypatch, tmp_path)
        assert main(["   ", "swarm"]) == 2
        assert main(["strategy", "   "]) == 2

    def test_missing_config_returns_2(self, monkeypatch, tmp_path, capsys):
        self._setup(monkeypatch, tmp_path, config_text=None)
        assert main(["strategy", "swarm"]) == 2
        assert "not found" in capsys.readouterr().err
