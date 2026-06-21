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
    def _run(self, monkeypatch, tmp_path, *, stdin_data: str = "{}"):
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        monkeypatch.setattr("sys.stdin", io.StringIO(stdin_data))
        return main()

    def test_returns_empty_when_no_content(self, monkeypatch, tmp_path, capsys):
        ret = self._run(monkeypatch, tmp_path)
        assert ret == 0
        out = capsys.readouterr().out.strip()
        assert out == "{}"

    def test_emits_hook_output_with_content(self, monkeypatch, tmp_path, capsys):
        (tmp_path / "PULSE.md").write_text("pulse persona content")
        self._run(monkeypatch, tmp_path)
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert "pulse persona content" in data["hookSpecificOutput"]["additionalContext"]

    def test_strips_whitespace_from_content(self, monkeypatch, tmp_path, capsys):
        (tmp_path / "PULSE.md").write_text("  content with spaces  \n")
        self._run(monkeypatch, tmp_path)
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert data["hookSpecificOutput"]["additionalContext"] == "content with spaces"

    def test_default_event_name(self, monkeypatch, tmp_path, capsys):
        (tmp_path / "PULSE.md").write_text("content")
        self._run(monkeypatch, tmp_path)
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert data["hookSpecificOutput"]["hookEventName"] == "UserPromptSubmit"

    def test_custom_event_name_from_stdin(self, monkeypatch, tmp_path, capsys):
        (tmp_path / "PULSE.md").write_text("content")
        self._run(monkeypatch, tmp_path, stdin_data='{"hook_event_name": "MyEvent"}')
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert data["hookSpecificOutput"]["hookEventName"] == "MyEvent"

    def test_invalid_json_stdin_uses_default_event(self, monkeypatch, tmp_path, capsys):
        (tmp_path / "PULSE.md").write_text("content")
        self._run(monkeypatch, tmp_path, stdin_data="{bad json}")
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert data["hookSpecificOutput"]["hookEventName"] == "UserPromptSubmit"

    def test_non_string_event_name_ignored(self, monkeypatch, tmp_path, capsys):
        (tmp_path / "PULSE.md").write_text("content")
        self._run(monkeypatch, tmp_path, stdin_data='{"hook_event_name": null}')
        out = capsys.readouterr().out.strip()
        data = json.loads(out)
        assert data["hookSpecificOutput"]["hookEventName"] == "UserPromptSubmit"
