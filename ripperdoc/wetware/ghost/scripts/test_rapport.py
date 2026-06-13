import importlib.util
import io
import json
import sqlite3
from pathlib import Path

spec = importlib.util.spec_from_file_location("rapport", Path(__file__).parent / "rapport.py")
assert spec is not None and spec.loader is not None
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

read_rapport = mod.read_rapport
main = mod.main


def _make_db(path: Path, *, trust: int = 0, attachment: int = 0, instability: int = 0) -> None:
    """Create a sqlite DB at `path` with a populated rapport row."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS rapport (
                id          INTEGER PRIMARY KEY CHECK (id = 1),
                trust       INTEGER NOT NULL DEFAULT 0,
                attachment  INTEGER NOT NULL DEFAULT 0,
                instability INTEGER NOT NULL DEFAULT 0,
                updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
            );
        """)
        db.execute(
            "INSERT OR REPLACE INTO rapport (id, trust, attachment, instability) VALUES (1, ?, ?, ?)",
            (trust, attachment, instability),
        )


def _make_db_no_table(path: Path) -> None:
    """Create a sqlite DB at `path` without the rapport table."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE other (id INTEGER PRIMARY KEY)")


# ── read_rapport ──────────────────────────────────────────────────────────────


class TestReadRapport:
    def test_missing_db_returns_none(self, tmp_path, monkeypatch):
        rapport_md = tmp_path / "RAPPORT.md"
        rapport_md.write_text("# Rapport\ntrust: {trust}\n")
        monkeypatch.setattr(mod, "DB_PATH", tmp_path / "missing.db")
        monkeypatch.setattr(mod, "RAPPORT_MD", rapport_md)
        assert read_rapport() is None

    def test_missing_rapport_md_returns_none(self, tmp_path, monkeypatch):
        db_path = tmp_path / "cortex.db"
        _make_db(db_path)
        monkeypatch.setattr(mod, "DB_PATH", db_path)
        monkeypatch.setattr(mod, "RAPPORT_MD", tmp_path / "missing.md")
        assert read_rapport() is None

    def test_db_without_rapport_table_returns_none(self, tmp_path, monkeypatch):
        db_path = tmp_path / "cortex.db"
        _make_db_no_table(db_path)
        rapport_md = tmp_path / "RAPPORT.md"
        rapport_md.write_text("# Rapport\ntrust: {trust}\n")
        monkeypatch.setattr(mod, "DB_PATH", db_path)
        monkeypatch.setattr(mod, "RAPPORT_MD", rapport_md)
        assert read_rapport() is None

    def test_returns_interpolated_template(self, tmp_path, monkeypatch):
        db_path = tmp_path / "cortex.db"
        _make_db(db_path, trust=5, attachment=-3, instability=12)
        rapport_md = tmp_path / "RAPPORT.md"
        rapport_md.write_text("# Rapport\ntrust: {trust}\nattachment: {attachment}\ninstability: {instability}\n")
        monkeypatch.setattr(mod, "DB_PATH", db_path)
        monkeypatch.setattr(mod, "RAPPORT_MD", rapport_md)
        result = read_rapport()
        assert result is not None
        assert "# Rapport" in result
        assert "trust: 5" in result
        assert "attachment: -3" in result
        assert "instability: 12" in result

    def test_no_leftover_placeholders(self, tmp_path, monkeypatch):
        db_path = tmp_path / "cortex.db"
        _make_db(db_path, trust=1, attachment=2, instability=3)
        rapport_md = tmp_path / "RAPPORT.md"
        rapport_md.write_text("trust: {trust}\nattachment: {attachment}\ninstability: {instability}\n")
        monkeypatch.setattr(mod, "DB_PATH", db_path)
        monkeypatch.setattr(mod, "RAPPORT_MD", rapport_md)
        result = read_rapport()
        assert result is not None
        assert "{" not in result
        assert "}" not in result


# ── main ──────────────────────────────────────────────────────────────────────


class TestMain:
    def _run(self, monkeypatch, *, stdin_data: str = "{}"):
        monkeypatch.setattr("sys.stdin", io.StringIO(stdin_data))
        return main()

    def test_missing_db_emits_empty_envelope(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setattr(mod, "DB_PATH", tmp_path / "missing.db")
        monkeypatch.setattr(mod, "RAPPORT_MD", tmp_path / "missing.md")
        ret = self._run(monkeypatch)
        assert ret == 0
        out = capsys.readouterr().out.strip()
        assert out == "{}"

    def test_populated_db_emits_rapport_block(self, tmp_path, monkeypatch, capsys):
        db_path = tmp_path / "cortex.db"
        _make_db(db_path, trust=7, attachment=4, instability=-2)
        rapport_md = tmp_path / "RAPPORT.md"
        rapport_md.write_text("# Rapport\ntrust: {trust}\nattachment: {attachment}\ninstability: {instability}\n")
        monkeypatch.setattr(mod, "DB_PATH", db_path)
        monkeypatch.setattr(mod, "RAPPORT_MD", rapport_md)
        self._run(monkeypatch)
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        ctx = data["hookSpecificOutput"]["additionalContext"]
        assert "# Rapport" in ctx
        assert "trust: 7" in ctx
        assert "attachment: 4" in ctx
        assert "instability: -2" in ctx

    def test_custom_event_name_from_stdin(self, tmp_path, monkeypatch, capsys):
        db_path = tmp_path / "cortex.db"
        _make_db(db_path, trust=1, attachment=2, instability=3)
        rapport_md = tmp_path / "RAPPORT.md"
        rapport_md.write_text("# Rapport\ntrust: {trust}\nattachment: {attachment}\ninstability: {instability}\n")
        monkeypatch.setattr(mod, "DB_PATH", db_path)
        monkeypatch.setattr(mod, "RAPPORT_MD", rapport_md)
        self._run(monkeypatch, stdin_data='{"hook_event_name": "foo"}')
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert data["hookSpecificOutput"]["hookEventName"] == "foo"

    def test_default_event_name_when_missing(self, tmp_path, monkeypatch, capsys):
        db_path = tmp_path / "cortex.db"
        _make_db(db_path, trust=1, attachment=2, instability=3)
        rapport_md = tmp_path / "RAPPORT.md"
        rapport_md.write_text("# Rapport\ntrust: {trust}\nattachment: {attachment}\ninstability: {instability}\n")
        monkeypatch.setattr(mod, "DB_PATH", db_path)
        monkeypatch.setattr(mod, "RAPPORT_MD", rapport_md)
        self._run(monkeypatch, stdin_data="{}")
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert data["hookSpecificOutput"]["hookEventName"] == "SessionStart"

    def test_malformed_json_uses_default_event(self, tmp_path, monkeypatch, capsys):
        db_path = tmp_path / "cortex.db"
        _make_db(db_path, trust=1, attachment=2, instability=3)
        rapport_md = tmp_path / "RAPPORT.md"
        rapport_md.write_text("# Rapport\ntrust: {trust}\nattachment: {attachment}\ninstability: {instability}\n")
        monkeypatch.setattr(mod, "DB_PATH", db_path)
        monkeypatch.setattr(mod, "RAPPORT_MD", rapport_md)
        self._run(monkeypatch, stdin_data="{not valid json")
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert data["hookSpecificOutput"]["hookEventName"] == "SessionStart"

    def test_non_string_event_name_uses_default(self, tmp_path, monkeypatch, capsys):
        db_path = tmp_path / "cortex.db"
        _make_db(db_path, trust=1, attachment=2, instability=3)
        rapport_md = tmp_path / "RAPPORT.md"
        rapport_md.write_text("# Rapport\ntrust: {trust}\nattachment: {attachment}\ninstability: {instability}\n")
        monkeypatch.setattr(mod, "DB_PATH", db_path)
        monkeypatch.setattr(mod, "RAPPORT_MD", rapport_md)
        self._run(monkeypatch, stdin_data='{"hook_event_name": 42}')
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert data["hookSpecificOutput"]["hookEventName"] == "SessionStart"
