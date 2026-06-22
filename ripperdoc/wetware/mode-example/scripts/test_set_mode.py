import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location("set_mode", Path(__file__).parent / "set_mode.py")
assert spec is not None and spec.loader is not None
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

available_modes = mod.available_modes
set_mode = mod.set_mode
main = mod.main


# ── available_modes ─────────────────────────────────────────────────────────────


class TestAvailableModes:
    def test_lists_stems_sorted(self, tmp_path, monkeypatch):
        d = tmp_path / "modes"
        d.mkdir()
        (d / "mode-b.md").write_text("b")
        (d / "mode-a.md").write_text("a")
        monkeypatch.setattr(mod, "MODES_DIR", d)
        assert available_modes() == ["mode-a", "mode-b"]

    def test_empty_when_no_dir(self, tmp_path, monkeypatch):
        monkeypatch.setattr(mod, "MODES_DIR", tmp_path / "nope")
        assert available_modes() == []


# ── set_mode (atomic, key-preserving write) ──────────────────────────────────────


class TestSetMode:
    def test_sets_field_and_preserves_others(self, tmp_path):
        cfg = tmp_path / "preemdeck.json"
        cfg.write_text('{\n  "mode-example": "mode-a",\n  "other": 1\n}\n')
        set_mode(cfg, "mode-b")
        assert json.loads(cfg.read_text()) == {"mode-example": "mode-b", "other": 1}

    def test_creates_field_when_missing(self, tmp_path):
        cfg = tmp_path / "preemdeck.json"
        cfg.write_text('{"keep": true}')
        set_mode(cfg, "mode-c")
        assert json.loads(cfg.read_text()) == {"keep": True, "mode-example": "mode-c"}

    def test_fixed_two_space_framing_with_trailing_newline(self, tmp_path):
        cfg = tmp_path / "preemdeck.json"
        cfg.write_text("{}")
        set_mode(cfg, "mode-a")
        assert cfg.read_text() == '{\n  "mode-example": "mode-a"\n}\n'

    def test_idempotent(self, tmp_path):
        cfg = tmp_path / "preemdeck.json"
        cfg.write_text('{"mode-example": "mode-a"}')
        set_mode(cfg, "mode-a")
        first = cfg.read_text()
        set_mode(cfg, "mode-a")
        assert cfg.read_text() == first

    def test_leaves_no_tmp_behind(self, tmp_path):
        cfg = tmp_path / "preemdeck.json"
        cfg.write_text("{}")
        set_mode(cfg, "mode-a")
        assert list(tmp_path.glob("*.tmp")) == []


# ── main (validation + exit codes) ───────────────────────────────────────────────


class TestMain:
    def _setup(self, monkeypatch, tmp_path, *, config_text='{"mode-example": "mode-a"}'):
        d = tmp_path / "modes"
        d.mkdir()
        for m in ("mode-a", "mode-b", "mode-c"):
            (d / f"{m}.md").write_text("x")
        monkeypatch.setattr(mod, "MODES_DIR", d)
        monkeypatch.setattr(mod, "SEARCH_START", tmp_path)
        if config_text is not None:
            (tmp_path / "preemdeck.json").write_text(config_text)
        return tmp_path / "preemdeck.json"

    def test_valid_mode_sets_and_returns_0(self, monkeypatch, tmp_path):
        cfg = self._setup(monkeypatch, tmp_path)
        assert main(["mode-b"]) == 0
        assert json.loads(cfg.read_text())["mode-example"] == "mode-b"

    def test_unknown_mode_returns_2_without_writing(self, monkeypatch, tmp_path, capsys):
        cfg = self._setup(monkeypatch, tmp_path)
        assert main(["mode-z"]) == 2
        assert json.loads(cfg.read_text())["mode-example"] == "mode-a"  # untouched
        assert "available" in capsys.readouterr().err

    def test_no_arg_returns_2(self, monkeypatch, tmp_path):
        self._setup(monkeypatch, tmp_path)
        assert main([]) == 2

    def test_blank_arg_returns_2(self, monkeypatch, tmp_path):
        self._setup(monkeypatch, tmp_path)
        assert main(["   "]) == 2

    def test_missing_config_returns_2(self, monkeypatch, tmp_path, capsys):
        self._setup(monkeypatch, tmp_path, config_text=None)
        assert main(["mode-a"]) == 2
        assert "not found" in capsys.readouterr().err
