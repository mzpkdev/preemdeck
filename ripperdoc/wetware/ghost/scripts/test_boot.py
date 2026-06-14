import base64
import importlib.util
import io
import json
import sqlite3
from pathlib import Path

spec = importlib.util.spec_from_file_location("boot", Path(__file__).parent / "boot.py")
assert spec is not None and spec.loader is not None
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

read_short_term = mod.read_short_term
read_source = mod.read_source
main = mod.main


# ── helpers ───────────────────────────────────────────────────────────────────


def _make_db(path: Path, rows: list[str]) -> None:
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE memories (memory TEXT, surfaced REAL, recorded_at TEXT)")
        for row in rows:
            db.execute("INSERT INTO memories VALUES (?, 0, '2024-01-01')", (row,))


# ── read_short_term ───────────────────────────────────────────────────────────


class TestReadShortTerm:
    def test_returns_none_when_db_missing(self, tmp_path, monkeypatch):
        monkeypatch.setattr(mod, "DB_PATH", tmp_path / "nonexistent.db")
        assert read_short_term() is None

    def test_returns_none_when_table_empty(self, tmp_path, monkeypatch):
        db_path = tmp_path / "cortex.db"
        _make_db(db_path, [])
        monkeypatch.setattr(mod, "DB_PATH", db_path)
        assert read_short_term() is None

    def test_returns_formatted_memories(self, tmp_path, monkeypatch):
        db_path = tmp_path / "cortex.db"
        _make_db(db_path, ["likes Python", "dislikes YAML"])
        monkeypatch.setattr(mod, "DB_PATH", db_path)
        result = read_short_term()
        assert result is not None
        assert result.startswith("Facts known about the user")
        assert "- likes Python" in result
        assert "- dislikes YAML" in result

    def test_limits_to_10_rows(self, tmp_path, monkeypatch):
        db_path = tmp_path / "cortex.db"
        _make_db(db_path, [f"fact {i}" for i in range(15)])
        monkeypatch.setattr(mod, "DB_PATH", db_path)
        result = read_short_term()
        assert result is not None
        lines = [ln for ln in result.splitlines() if ln.startswith("- ")]
        assert len(lines) == 10


# ── read_source ───────────────────────────────────────────────────────────────


class TestReadSource:
    def test_returns_none_when_both_missing(self, tmp_path, monkeypatch):
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        assert read_source("boot.dat", "BOOT.md") is None

    def test_reads_dat_file_over_md(self, tmp_path, monkeypatch):
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        content = "hello from dat"
        (tmp_path / "boot.dat").write_bytes(base64.b64encode(content.encode()))
        (tmp_path / "BOOT.md").write_text("hello from md")
        assert read_source("boot.dat", "BOOT.md") == content

    def test_reads_md_when_dat_missing(self, tmp_path, monkeypatch):
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        (tmp_path / "BOOT.md").write_text("boot content")
        assert read_source("boot.dat", "BOOT.md") == "boot content"

    def test_decodes_base64_dat(self, tmp_path, monkeypatch):
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        raw = "persona data here"
        (tmp_path / "engram.dat").write_bytes(base64.b64encode(raw.encode()))
        assert read_source("engram.dat", "ENGRAM.md") == raw


# ── main ──────────────────────────────────────────────────────────────────────


class TestMain:
    def _run(self, monkeypatch, tmp_path, *, sentinel_exists: bool, stdin_data: str = "{}"):
        sentinel = tmp_path / ".ghost"
        if sentinel_exists:
            sentinel.touch()
        monkeypatch.setattr(mod, "GHOST_SENTINEL", sentinel)
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        monkeypatch.setattr(mod, "DB_PATH", tmp_path / "cortex.db")
        monkeypatch.setattr("sys.stdin", io.StringIO(stdin_data))
        return main()

    def test_returns_zero_when_no_content(self, monkeypatch, tmp_path, capsys):
        ret = self._run(monkeypatch, tmp_path, sentinel_exists=True)
        assert ret == 0
        out = capsys.readouterr().out.strip()
        assert out == "{}"

    def test_skips_boot_when_sentinel_present(self, monkeypatch, tmp_path, capsys):
        (tmp_path / "BOOT.md").write_text("boot persona")
        ret = self._run(monkeypatch, tmp_path, sentinel_exists=True)
        assert ret == 0
        out = capsys.readouterr().out.strip()
        assert out == "{}"

    def test_includes_boot_when_sentinel_absent(self, monkeypatch, tmp_path, capsys):
        (tmp_path / "BOOT.md").write_text("boot persona")
        self._run(monkeypatch, tmp_path, sentinel_exists=False)
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert "boot persona" in data["hookSpecificOutput"]["additionalContext"]

    def test_includes_engram_regardless_of_sentinel(self, monkeypatch, tmp_path, capsys):
        (tmp_path / "ENGRAM.md").write_text("engram content")
        self._run(monkeypatch, tmp_path, sentinel_exists=True)
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert "engram content" in data["hookSpecificOutput"]["additionalContext"]

    def test_includes_firmware_regardless_of_sentinel(self, monkeypatch, tmp_path, capsys):
        (tmp_path / "FIRMWARE.md").write_text("firmware content")
        self._run(monkeypatch, tmp_path, sentinel_exists=True)
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert "firmware content" in data["hookSpecificOutput"]["additionalContext"]

    def test_includes_short_term_memory(self, monkeypatch, tmp_path, capsys):
        db_path = tmp_path / "cortex.db"
        _make_db(db_path, ["user prefers dark mode"])
        (tmp_path / "ENGRAM.md").write_text("engram")
        monkeypatch.setattr(mod, "GHOST_SENTINEL", tmp_path / ".ghost")
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        monkeypatch.setattr(mod, "DB_PATH", db_path)
        monkeypatch.setattr("sys.stdin", io.StringIO("{}"))
        main()
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert "user prefers dark mode" in data["hookSpecificOutput"]["additionalContext"]

    def test_default_event_name(self, monkeypatch, tmp_path, capsys):
        (tmp_path / "ENGRAM.md").write_text("content")
        self._run(monkeypatch, tmp_path, sentinel_exists=True)
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert data["hookSpecificOutput"]["hookEventName"] == "SessionStart"

    def test_custom_event_name_from_stdin(self, monkeypatch, tmp_path, capsys):
        (tmp_path / "ENGRAM.md").write_text("content")
        self._run(monkeypatch, tmp_path, sentinel_exists=True, stdin_data='{"hook_event_name": "CustomEvent"}')
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert data["hookSpecificOutput"]["hookEventName"] == "CustomEvent"

    def test_invalid_json_stdin_uses_default_event(self, monkeypatch, tmp_path, capsys):
        (tmp_path / "ENGRAM.md").write_text("content")
        self._run(monkeypatch, tmp_path, sentinel_exists=True, stdin_data="not json")
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert data["hookSpecificOutput"]["hookEventName"] == "SessionStart"

    def test_non_string_event_name_uses_default(self, monkeypatch, tmp_path, capsys):
        (tmp_path / "ENGRAM.md").write_text("content")
        self._run(monkeypatch, tmp_path, sentinel_exists=True, stdin_data='{"hook_event_name": 42}')
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert data["hookSpecificOutput"]["hookEventName"] == "SessionStart"
