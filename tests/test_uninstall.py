"""Tests for uninstall.py"""

import json
from pathlib import Path
from unittest.mock import patch

import pytest

import install
import uninstall


def _seed_manifest(repo_root: Path, payload: dict) -> None:
    (repo_root / install.MANIFEST_FILE).write_text(json.dumps(payload))


# load_manifest_or_exit


def test_load_manifest_or_exit_reads_valid(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(uninstall, "REPO_ROOT", tmp_path)
    payload = {"schema": install.MANIFEST_SCHEMA, "harnesses": {"claude": {"overlay": []}}}
    _seed_manifest(tmp_path, payload)
    assert uninstall.load_manifest_or_exit() == payload


def test_load_manifest_or_exit_missing_exits_1(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(uninstall, "REPO_ROOT", tmp_path)
    with pytest.raises(SystemExit) as exc_info:
        uninstall.load_manifest_or_exit()
    assert exc_info.value.code == 1
    assert "nothing to uninstall" in capsys.readouterr().err


def test_load_manifest_or_exit_bad_schema_exits_1(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(uninstall, "REPO_ROOT", tmp_path)
    _seed_manifest(tmp_path, {"schema": 2, "harnesses": {"claude": {}}})
    with pytest.raises(SystemExit) as exc_info:
        uninstall.load_manifest_or_exit()
    assert exc_info.value.code == 1


# reverse_overlay


def test_reverse_overlay_restores_from_backup(tmp_path: Path) -> None:
    dst = tmp_path / "settings.json"
    bak = tmp_path / "settings.json.bak"
    dst.write_text("overlay-content")
    bak.write_text("user-original")
    records = [{"dst": str(dst), "src": "root/claude/settings.json", "backup": str(bak), "action": "overwrite"}]

    restored, removed = uninstall.reverse_overlay(records, dry_run=False)

    assert (restored, removed) == (1, 0)
    # Backup moved back over dst; backup file consumed.
    assert dst.read_text() == "user-original"
    assert not bak.exists()


def test_reverse_overlay_deletes_when_no_backup(tmp_path: Path) -> None:
    dst = tmp_path / "fixer.md"
    dst.write_text("overlay-created")
    records = [{"dst": str(dst), "src": "root/claude/fixer.md", "backup": None, "action": "create"}]

    restored, removed = uninstall.reverse_overlay(records, dry_run=False)

    assert (restored, removed) == (0, 1)
    assert not dst.exists()


def test_reverse_overlay_tolerates_missing(tmp_path: Path) -> None:
    dst = tmp_path / "gone.md"
    records = [{"dst": str(dst), "src": "root/claude/gone.md", "backup": None, "action": "create"}]
    restored, removed = uninstall.reverse_overlay(records, dry_run=False)
    assert (restored, removed) == (0, 0)


def test_reverse_overlay_dry_run_writes_nothing(tmp_path: Path) -> None:
    dst = tmp_path / "fixer.md"
    dst.write_text("overlay-created")
    records = [{"dst": str(dst), "src": "root/claude/fixer.md", "backup": None, "action": "create"}]
    restored, removed = uninstall.reverse_overlay(records, dry_run=True)
    assert (restored, removed) == (0, 1)
    # Counted as intent, but the file is untouched.
    assert dst.exists()


def test_reverse_overlay_processes_in_reverse_order(tmp_path: Path) -> None:
    a = tmp_path / "a.md"
    b = tmp_path / "b.md"
    a.write_text("a")
    b.write_text("b")
    records = [
        {"dst": str(a), "src": "root/claude/a.md", "backup": None, "action": "create"},
        {"dst": str(b), "src": "root/claude/b.md", "backup": None, "action": "create"},
    ]
    calls: list[str] = []
    real_unlink = Path.unlink

    def spy_unlink(self: Path, *args: object, **kwargs: object) -> None:
        calls.append(self.name)
        real_unlink(self, *args, **kwargs)

    with patch.object(Path, "unlink", spy_unlink):
        uninstall.reverse_overlay(records, dry_run=False)
    assert calls == ["b.md", "a.md"]


# unregister (assert command shapes via mocked run_cli)


def test_unregister_gemini_uses_extensions_uninstall() -> None:
    record = {"plugins": [{"host": "gemini", "rack": "dock", "name": "fixer"}], "marketplaces": []}
    with patch("install.run_cli", return_value=(True, "")) as mock_run:
        plugins_done, markets_done = uninstall.unregister("gemini", record, dry_run=False)
    assert (plugins_done, markets_done) == (1, 0)
    mock_run.assert_called_once_with(["gemini", "extensions", "uninstall", "fixer"], dry_run=False)


def test_unregister_claude_plugin_and_marketplace() -> None:
    record = {
        "plugins": [{"host": "claude", "rack": "dock", "name": "fixer"}],
        "marketplaces": ["dock"],
    }
    with patch("install.run_cli", return_value=(True, "")) as mock_run:
        plugins_done, markets_done = uninstall.unregister("claude", record, dry_run=False)
    assert (plugins_done, markets_done) == (1, 1)
    mock_run.assert_any_call(["claude", "plugin", "uninstall", "fixer"], dry_run=False)
    # `marketplace remove` takes the marketplace NAME (as stored in the manifest),
    # not the rack path that `add` was given.
    mock_run.assert_any_call(["claude", "plugin", "marketplace", "remove", "dock"], dry_run=False)


def test_unregister_gemini_skips_marketplaces() -> None:
    record = {"plugins": [], "marketplaces": ["dock"]}
    with patch("install.run_cli", return_value=(True, "")) as mock_run:
        plugins_done, markets_done = uninstall.unregister("gemini", record, dry_run=False)
    assert (plugins_done, markets_done) == (0, 0)
    mock_run.assert_not_called()


def test_unregister_tolerates_not_found() -> None:
    record = {"plugins": [{"host": "claude", "rack": "dock", "name": "fixer"}], "marketplaces": []}
    with patch("install.run_cli", return_value=(False, "plugin not found")):
        plugins_done, _ = uninstall.unregister("claude", record, dry_run=False)
    # "not found" stderr is treated as already-done and still counted.
    assert plugins_done == 1


def test_unregister_dry_run_runs_nothing() -> None:
    record = {
        "plugins": [{"host": "claude", "rack": "dock", "name": "fixer"}],
        "marketplaces": ["dock"],
    }
    with patch("install.run_cli") as mock_run:
        plugins_done, markets_done = uninstall.unregister("claude", record, dry_run=True)
    assert (plugins_done, markets_done) == (1, 1)
    mock_run.assert_not_called()


# write_manifest (uninstall's manifest mutation)


def test_uninstall_write_manifest_rewrites_when_harnesses_remain(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(uninstall, "REPO_ROOT", tmp_path)
    manifest = {"schema": install.MANIFEST_SCHEMA, "harnesses": {"gemini": {"overlay": []}}}
    uninstall.write_manifest(manifest, dry_run=False)
    data = json.loads((tmp_path / install.MANIFEST_FILE).read_text())
    assert set(data["harnesses"]) == {"gemini"}


def test_uninstall_write_manifest_deletes_when_empty(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(uninstall, "REPO_ROOT", tmp_path)
    _seed_manifest(tmp_path, {"schema": install.MANIFEST_SCHEMA, "harnesses": {}})
    uninstall.write_manifest({"schema": install.MANIFEST_SCHEMA, "harnesses": {}}, dry_run=False)
    assert not (tmp_path / install.MANIFEST_FILE).exists()


def test_uninstall_write_manifest_dry_run_no_write(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(uninstall, "REPO_ROOT", tmp_path)
    uninstall.write_manifest({"schema": install.MANIFEST_SCHEMA, "harnesses": {"gemini": {}}}, dry_run=True)
    assert not (tmp_path / install.MANIFEST_FILE).exists()


# main (end-to-end manifest mutation: key dropped, file removed when last harness)


def test_main_drops_last_harness_and_removes_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(uninstall, "REPO_ROOT", tmp_path)
    dst = tmp_path / "settings.json"
    dst.write_text("overlay")
    payload = {
        "schema": install.MANIFEST_SCHEMA,
        "harnesses": {
            "claude": {
                "overlay": [{"dst": str(dst), "src": "root/claude/settings.json", "backup": None, "action": "create"}],
                "marketplaces": [],
                "plugins": [],
            }
        },
    }
    _seed_manifest(tmp_path, payload)

    with patch("install.run_cli", return_value=(True, "")):
        rc = uninstall.main(["claude"])

    assert rc == 0
    # Overlay file removed, manifest gone (last harness).
    assert not dst.exists()
    assert not (tmp_path / install.MANIFEST_FILE).exists()


def test_main_drops_one_harness_keeps_others(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(uninstall, "REPO_ROOT", tmp_path)
    payload = {
        "schema": install.MANIFEST_SCHEMA,
        "harnesses": {
            "claude": {"overlay": [], "marketplaces": [], "plugins": []},
            "gemini": {"overlay": [], "marketplaces": [], "plugins": []},
        },
    }
    _seed_manifest(tmp_path, payload)

    with patch("install.run_cli", return_value=(True, "")):
        rc = uninstall.main(["claude"])

    assert rc == 0
    data = json.loads((tmp_path / install.MANIFEST_FILE).read_text())
    assert set(data["harnesses"]) == {"gemini"}


def test_main_dry_run_leaves_manifest_intact(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(uninstall, "REPO_ROOT", tmp_path)
    payload = {
        "schema": install.MANIFEST_SCHEMA,
        "harnesses": {"claude": {"overlay": [], "marketplaces": [], "plugins": []}},
    }
    _seed_manifest(tmp_path, payload)

    with patch("install.run_cli", return_value=(True, "")):
        rc = uninstall.main(["claude", "--dry-run"])

    assert rc == 0
    data = json.loads((tmp_path / install.MANIFEST_FILE).read_text())
    assert set(data["harnesses"]) == {"claude"}
