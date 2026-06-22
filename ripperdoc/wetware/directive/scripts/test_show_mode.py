import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("show_mode", Path(__file__).parent / "show_mode.py")
assert spec is not None and spec.loader is not None
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

available_modes = mod.available_modes
main = mod.main


def _write_skill(skills_dir, name, body):
    """Create skills/<name>/directive.md (the prose the echo skill prints)."""
    d = skills_dir / name
    d.mkdir(parents=True)
    (d / "directive.md").write_text(f"{body}\n")


# ── available_modes (skill folders that ship a directive.md) ─────────────────────


class TestAvailableModes:
    def test_lists_skills_with_directive_md(self, tmp_path, monkeypatch):
        d = tmp_path / "skills"
        d.mkdir()
        for n in ("swarm", "ask"):
            _write_skill(d, n, "body")
        monkeypatch.setattr(mod, "SKILLS_DIR", d)
        assert available_modes() == ["ask", "swarm"]


# ── main (print directive verbatim + reject unknown/unsafe) ──────────────────────


class TestMain:
    def _skills(self, tmp_path, monkeypatch):
        d = tmp_path / "skills"
        d.mkdir()
        monkeypatch.setattr(mod, "SKILLS_DIR", d)
        return d

    def test_prints_directive_verbatim(self, tmp_path, monkeypatch, capsys):
        d = self._skills(tmp_path, monkeypatch)
        (d / "swarm").mkdir()
        body = "# Strategy: swarm\n\nOrchestrate — don't do.\n"
        (d / "swarm" / "directive.md").write_text(body)
        assert main(["swarm"]) == 0
        assert capsys.readouterr().out == body  # byte-for-byte, no framing

    def test_unknown_value_returns_2(self, tmp_path, monkeypatch, capsys):
        d = self._skills(tmp_path, monkeypatch)
        _write_skill(d, "swarm", "body")
        assert main(["nope"]) == 2
        assert "swarm" in capsys.readouterr().err  # lists available modes

    def test_wrong_arg_count_returns_2(self, tmp_path, monkeypatch):
        self._skills(tmp_path, monkeypatch)
        assert main([]) == 2
        assert main(["swarm", "extra"]) == 2

    def test_blank_arg_returns_2(self, tmp_path, monkeypatch):
        self._skills(tmp_path, monkeypatch)
        assert main(["   "]) == 2

    def test_rejects_dotdot_escape(self, tmp_path, monkeypatch):
        self._skills(tmp_path, monkeypatch)
        outside = tmp_path / "secret"
        outside.mkdir()
        (outside / "directive.md").write_text("secret")
        assert main(["../secret"]) == 2

    def test_rejects_path_separator(self, tmp_path, monkeypatch):
        d = self._skills(tmp_path, monkeypatch)
        nested = d / "a" / "b"
        nested.mkdir(parents=True)
        (nested / "directive.md").write_text("nested")
        assert main(["a/b"]) == 2
