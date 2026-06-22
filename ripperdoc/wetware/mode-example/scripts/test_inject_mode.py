import importlib.util
import io
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location("inject_mode", Path(__file__).parent / "inject_mode.py")
assert spec is not None and spec.loader is not None
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

find_config = mod.find_config
select_mode = mod.select_mode
load_mode_text = mod.load_mode_text
main = mod.main


# ── find_config (OS-agnostic upward walk) ───────────────────────────────────────


class TestFindConfig:
    def test_returns_none_when_absent(self, tmp_path):
        assert find_config(tmp_path) is None

    def test_finds_in_start_dir(self, tmp_path):
        cfg = tmp_path / "preemdeck.json"
        cfg.write_text("{}")
        assert find_config(tmp_path) == cfg

    def test_walks_up_to_ancestor(self, tmp_path):
        # Mirrors the installed layout: script nested under the clone root,
        # preemdeck.json at that root.
        cfg = tmp_path / "preemdeck.json"
        cfg.write_text("{}")
        nested = tmp_path / "plugins" / "cache" / "mode-example" / "scripts"
        nested.mkdir(parents=True)
        assert find_config(nested) == cfg

    def test_nearest_ancestor_wins(self, tmp_path):
        (tmp_path / "preemdeck.json").write_text('{"loc": "far"}')
        near_dir = tmp_path / "a" / "b"
        near_dir.mkdir(parents=True)
        near = near_dir / "preemdeck.json"
        near.write_text('{"loc": "near"}')
        assert find_config(near_dir) == near


# ── select_mode ─────────────────────────────────────────────────────────────────


class TestSelectMode:
    def _cfg(self, tmp_path, text):
        p = tmp_path / "preemdeck.json"
        p.write_text(text)
        return p

    def test_reads_mode_field(self, tmp_path):
        assert select_mode(self._cfg(tmp_path, '{"mode-example": "mode-b"}')) == "mode-b"

    def test_none_when_field_missing(self, tmp_path):
        assert select_mode(self._cfg(tmp_path, '{"other": "x"}')) is None

    def test_none_when_malformed(self, tmp_path):
        assert select_mode(self._cfg(tmp_path, "{bad json")) is None

    def test_none_when_value_not_string(self, tmp_path):
        assert select_mode(self._cfg(tmp_path, '{"mode-example": 42}')) is None

    def test_none_when_value_empty(self, tmp_path):
        assert select_mode(self._cfg(tmp_path, '{"mode-example": ""}')) is None


# ── load_mode_text ──────────────────────────────────────────────────────────────


class TestLoadModeText:
    def _modes(self, tmp_path, monkeypatch):
        d = tmp_path / "modes"
        d.mkdir()
        monkeypatch.setattr(mod, "MODES_DIR", d)
        return d

    def test_loads_existing_mode(self, tmp_path, monkeypatch):
        d = self._modes(tmp_path, monkeypatch)
        (d / "mode-a.md").write_text("  mode A body  \n")
        assert load_mode_text("mode-a") == "mode A body"

    def test_none_for_unknown_mode(self, tmp_path, monkeypatch):
        self._modes(tmp_path, monkeypatch)
        assert load_mode_text("mode-z") is None

    def test_none_for_empty_file(self, tmp_path, monkeypatch):
        d = self._modes(tmp_path, monkeypatch)
        (d / "blank.md").write_text("   \n")
        assert load_mode_text("blank") is None

    def test_rejects_path_traversal(self, tmp_path, monkeypatch):
        self._modes(tmp_path, monkeypatch)
        # A sibling file outside modes/ must not be reachable via `..`.
        (tmp_path / "secret.md").write_text("secret")
        assert load_mode_text("../secret") is None


# ── main (config → mode → md routing) ────────────────────────────────────────────


class TestMain:
    def _setup(self, monkeypatch, tmp_path, *, config_text=None, modes=None):
        if config_text is not None:
            (tmp_path / "preemdeck.json").write_text(config_text)
        modes_dir = tmp_path / "modes"
        modes_dir.mkdir()
        for name, body in (modes or {}).items():
            (modes_dir / f"{name}.md").write_text(body)
        monkeypatch.setattr(mod, "SEARCH_START", tmp_path)
        monkeypatch.setattr(mod, "MODES_DIR", modes_dir)

    def _run(self, monkeypatch, *, stdin_data="{}", argv=None):
        monkeypatch.setattr("sys.argv", ["inject_mode.py", *(argv or [])])
        monkeypatch.setattr("sys.stdin", io.StringIO(stdin_data))
        return main()

    def test_no_config_is_noop(self, monkeypatch, tmp_path, capsys):
        self._setup(monkeypatch, tmp_path)  # no config written
        assert self._run(monkeypatch) == 0
        assert capsys.readouterr().out.strip() == "{}"

    def test_routes_to_selected_mode(self, monkeypatch, tmp_path, capsys):
        self._setup(
            monkeypatch,
            tmp_path,
            config_text='{"mode-example": "mode-b"}',
            modes={"mode-a": "A body", "mode-b": "B body", "mode-c": "C body"},
        )
        self._run(monkeypatch)
        data = json.loads(capsys.readouterr().out.strip())
        assert data["hookSpecificOutput"]["additionalContext"] == "B body"

    def test_unknown_mode_is_noop(self, monkeypatch, tmp_path, capsys):
        self._setup(
            monkeypatch,
            tmp_path,
            config_text='{"mode-example": "mode-x"}',
            modes={"mode-a": "A body"},
        )
        self._run(monkeypatch)
        assert capsys.readouterr().out.strip() == "{}"

    def test_event_flag_fallback(self, monkeypatch, tmp_path, capsys):
        self._setup(
            monkeypatch,
            tmp_path,
            config_text='{"mode-example": "mode-a"}',
            modes={"mode-a": "A body"},
        )
        self._run(monkeypatch, argv=["--event", "BeforeAgent"])
        data = json.loads(capsys.readouterr().out.strip())
        assert data["hookSpecificOutput"]["hookEventName"] == "BeforeAgent"

    def test_stdin_event_overrides_flag(self, monkeypatch, tmp_path, capsys):
        self._setup(
            monkeypatch,
            tmp_path,
            config_text='{"mode-example": "mode-a"}',
            modes={"mode-a": "A body"},
        )
        self._run(
            monkeypatch,
            stdin_data='{"hook_event_name": "FromStdin"}',
            argv=["--event", "BeforeAgent"],
        )
        data = json.loads(capsys.readouterr().out.strip())
        assert data["hookSpecificOutput"]["hookEventName"] == "FromStdin"
