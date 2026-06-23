"""Tests for install.py"""

import json
from pathlib import Path
from unittest.mock import patch

import pytest

import install

# manifest_dir


def test_manifest_dir_claude() -> None:
    assert install.manifest_dir("claude") == ".claude-plugin"


def test_manifest_dir_codex() -> None:
    assert install.manifest_dir("codex") == ".agents/plugins"


# config_dir


def test_config_dir_returns_home_relative_dirs(monkeypatch: pytest.MonkeyPatch) -> None:
    home = Path("/home/somebody")
    monkeypatch.setattr(install.Path, "home", classmethod(lambda cls: home))
    assert install.config_dir("claude") == home / ".claude"
    assert install.config_dir("codex") == home / ".codex"
    assert install.config_dir("gemini") == home / ".gemini"


def test_config_dirnames_constant() -> None:
    assert install.CONFIG_DIRNAMES == {"claude": ".claude", "codex": ".codex", "gemini": ".gemini"}


# read_plugin_specs


def test_read_plugin_specs_returns_empty_when_no_manifest(tmp_path: Path) -> None:
    assert install.read_plugin_specs(tmp_path) == []


def test_read_plugin_specs_parses_names_and_paths(tmp_path: Path) -> None:
    manifest_dir = tmp_path / ".claude-plugin"
    manifest_dir.mkdir()
    (manifest_dir / "marketplace.json").write_text(
        json.dumps(
            {
                "name": "test",
                "plugins": [
                    {"name": "git", "source": "./git"},
                    {"name": "gh", "source": "./gh"},
                ],
            }
        )
    )
    specs = install.read_plugin_specs(tmp_path)
    assert [s.name for s in specs] == ["git", "gh"]
    assert [s.source_path for s in specs] == [
        (tmp_path / "git").resolve(),
        (tmp_path / "gh").resolve(),
    ]


def test_read_plugin_specs_handles_empty_plugins_array(tmp_path: Path) -> None:
    manifest_dir = tmp_path / ".claude-plugin"
    manifest_dir.mkdir()
    (manifest_dir / "marketplace.json").write_text(json.dumps({"name": "test", "plugins": []}))
    assert install.read_plugin_specs(tmp_path) == []


def test_read_plugin_specs_handles_malformed_json(tmp_path: Path) -> None:
    manifest_dir = tmp_path / ".claude-plugin"
    manifest_dir.mkdir()
    (manifest_dir / "marketplace.json").write_text("not valid json{")
    assert install.read_plugin_specs(tmp_path) == []


def test_read_plugin_specs_skips_entries_missing_name_or_source(tmp_path: Path) -> None:
    manifest_dir = tmp_path / ".claude-plugin"
    manifest_dir.mkdir()
    (manifest_dir / "marketplace.json").write_text(
        json.dumps(
            {
                "name": "test",
                "plugins": [
                    {"name": "git", "source": "./git"},
                    {"source": "./orphan"},
                    {"name": "no-source"},
                    {"name": "bad-source-type", "source": 42},
                ],
            }
        )
    )
    specs = install.read_plugin_specs(tmp_path)
    assert [s.name for s in specs] == ["git"]


def test_read_plugin_specs_skips_disabled_plugins(tmp_path: Path) -> None:
    manifest_dir = tmp_path / ".claude-plugin"
    manifest_dir.mkdir()
    (manifest_dir / "marketplace.json").write_text(
        json.dumps(
            {
                "name": "test",
                "plugins": [
                    {"name": "git", "source": "./git"},
                    {"name": "ghost", "source": "./ghost"},
                ],
            }
        )
    )
    specs = install.read_plugin_specs(tmp_path)
    assert [s.name for s in specs] == ["git"]


# register_marketplace


def test_register_marketplace_claude_invokes_cli() -> None:
    with patch("install.run_cli", return_value=(True, "")) as mock_run:
        ok, _ = install.register_marketplace("claude", Path("/some/rack"), dry_run=False)
    assert ok is True
    mock_run.assert_called_once_with(["claude", "plugin", "marketplace", "add", "/some/rack"], False)


def test_register_marketplace_codex_invokes_cli() -> None:
    with patch("install.run_cli", return_value=(True, "")) as mock_run:
        ok, _ = install.register_marketplace("codex", Path("/some/rack"), dry_run=False)
    assert ok is True
    mock_run.assert_called_once_with(["codex", "plugin", "marketplace", "add", "/some/rack"], False)


def test_register_marketplace_gemini_is_noop() -> None:
    with patch("install.run_cli") as mock_run:
        ok, msg = install.register_marketplace("gemini", Path("/some/rack"), dry_run=False)
    assert ok is True
    assert msg == ""
    mock_run.assert_not_called()


def test_register_marketplace_already_added_is_success() -> None:
    with patch("install.run_cli", return_value=(False, "marketplace already exists")):
        ok, _ = install.register_marketplace("claude", Path("/some/rack"), dry_run=False)
    assert ok is True


# install_plugin


def test_install_plugin_claude_uses_user_scope() -> None:
    spec = install.PluginSpec(name="format", source_path=Path("/some/rack/format"))
    with patch("install.run_cli", return_value=(True, "")) as mock_run:
        install.install_plugin("claude", spec, "chrome", dry_run=False)
    mock_run.assert_called_once_with(["claude", "plugin", "install", "format@chrome", "--scope", "user"], False)


def test_install_plugin_codex_no_scope_flag() -> None:
    spec = install.PluginSpec(name="format", source_path=Path("/some/rack/format"))
    with patch("install.run_cli", return_value=(True, "")) as mock_run:
        install.install_plugin("codex", spec, "chrome", dry_run=False)
    mock_run.assert_called_once_with(["codex", "plugin", "install", "format@chrome"], False)


def test_install_plugin_gemini_uses_extensions_install_with_path() -> None:
    spec = install.PluginSpec(name="format", source_path=Path("/some/rack/format"))
    with patch("install.run_cli", return_value=(True, "")) as mock_run:
        install.install_plugin("gemini", spec, "chrome", dry_run=False)
    mock_run.assert_called_once_with(["gemini", "extensions", "install", "--path", "/some/rack/format"], False)


# run_cli


def test_run_cli_dry_run_returns_success() -> None:
    ok, msg = install.run_cli(["echo", "test"], dry_run=True)
    assert ok is True
    assert msg == ""


def test_run_cli_success() -> None:
    ok, _ = install.run_cli(["echo", "hello"], dry_run=False)
    assert ok is True


def test_run_cli_failure() -> None:
    ok, msg = install.run_cli(["false"], dry_run=False)
    assert ok is False
    assert msg != ""


def test_run_cli_command_not_found() -> None:
    ok, msg = install.run_cli(["nonexistent-command-12345-xyz"], dry_run=False)
    assert ok is False
    assert msg


# copy_overlay


def _seed_overlay(repo_root: Path, harness: str = "claude") -> None:
    """Stage a `root/<harness>/` overlay tree under repo_root."""
    src = repo_root / install.STAGING_ROOT / harness
    (src / "agents").mkdir(parents=True)
    (src / "settings.json").write_text('{"_": "overlay"}')
    (src / "agents" / "fixer.md").write_text("# fixer overlay")


def test_copy_overlay_create_no_backup(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    config = tmp_path / "config"
    _seed_overlay(repo_root)

    ok, err, records = install.copy_overlay("claude", repo_root, config, dry_run=False)

    assert (ok, err) == (True, "")
    assert (config / "settings.json").read_text() == '{"_": "overlay"}'
    assert (config / "agents" / "fixer.md").read_text() == "# fixer overlay"
    assert {r["action"] for r in records} == {"create"}
    assert all(r["backup"] is None for r in records)
    # No backups written on a fresh create.
    assert list(config.rglob("*.bak")) == []
    # src is recorded repo-relative; dst absolute.
    for r in records:
        assert not Path(r["src"]).is_absolute()
        assert Path(r["dst"]).is_absolute()


def test_copy_overlay_missing_root_returns_empty(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    config = tmp_path / "config"
    ok, err, records = install.copy_overlay("claude", repo_root, config, dry_run=False)
    assert (ok, err, records) == (True, "", [])


def test_copy_overlay_overwrite_backs_up_original(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    config = tmp_path / "config"
    _seed_overlay(repo_root)
    config.mkdir()
    (config / "settings.json").write_text('{"_": "user-original"}')

    ok, err, records = install.copy_overlay("claude", repo_root, config, dry_run=False)

    assert (ok, err) == (True, "")
    # The user's original landed at .bak; the overlay clobbered the live file.
    assert (config / "settings.json.bak").read_text() == '{"_": "user-original"}'
    assert (config / "settings.json").read_text() == '{"_": "overlay"}'
    settings_rec = next(r for r in records if r["dst"].endswith("settings.json"))
    assert settings_rec["action"] == "overwrite"
    assert settings_rec["backup"] == str(config / "settings.json.bak")


def test_copy_overlay_repeat_skips_rebackup_for_recorded_file(tmp_path: Path) -> None:
    """A file already recorded in the manifest is re-overwritten, not re-backed-up."""
    repo_root = tmp_path / "repo"
    config = tmp_path / "config"
    _seed_overlay(repo_root)
    config.mkdir()
    (config / "settings.json").write_text('{"_": "user-original"}')

    # First install: backs up the user's original and records the write.
    _, _, records1 = install.copy_overlay("claude", repo_root, config, dry_run=False)
    install.write_manifest(repo_root, "claude", records1, [], [], dry_run=False)
    assert (config / "settings.json.bak").read_text() == '{"_": "user-original"}'

    # Mutate the source so the second copy is observable, then re-run.
    (repo_root / install.STAGING_ROOT / "claude" / "settings.json").write_text('{"_": "overlay-v2"}')
    _, _, records2 = install.copy_overlay("claude", repo_root, config, dry_run=False)

    assert (config / "settings.json").read_text() == '{"_": "overlay-v2"}'
    # The .bak still holds the ORIGINAL user file — not the overlay-v1 we wrote.
    assert (config / "settings.json.bak").read_text() == '{"_": "user-original"}'
    # No `.bak.<ts>` rebackup was made.
    assert list(config.glob("settings.json.bak.*")) == []
    settings_rec = next(r for r in records2 if r["dst"].endswith("settings.json"))
    assert settings_rec["backup"] is None
    assert settings_rec["action"] == "overwrite"


def test_copy_overlay_second_backup_uses_timestamp_suffix(tmp_path: Path) -> None:
    """An unrecorded pre-existing file with a `.bak` already present falls back to `.bak.<ts>`."""
    repo_root = tmp_path / "repo"
    config = tmp_path / "config"
    _seed_overlay(repo_root)
    config.mkdir()
    (config / "settings.json").write_text('{"_": "user-original"}')
    # A stale .bak already squats the primary backup slot (no manifest record).
    (config / "settings.json.bak").write_text('{"_": "stale-bak"}')

    _, _, records = install.copy_overlay("claude", repo_root, config, dry_run=False)

    # Primary .bak is preserved; the original spills into a timestamped backup.
    assert (config / "settings.json.bak").read_text() == '{"_": "stale-bak"}'
    ts_backups = list(config.glob("settings.json.bak.*"))
    assert len(ts_backups) == 1
    assert ts_backups[0].read_text() == '{"_": "user-original"}'
    settings_rec = next(r for r in records if r["dst"].endswith("settings.json"))
    assert settings_rec["backup"] == str(ts_backups[0])


def test_copy_overlay_dry_run_writes_nothing_but_records(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    config = tmp_path / "config"
    _seed_overlay(repo_root)
    config.mkdir()
    (config / "settings.json").write_text('{"_": "user-original"}')

    ok, err, records = install.copy_overlay("claude", repo_root, config, dry_run=True)

    assert (ok, err) == (True, "")
    # Nothing copied, nothing backed up.
    assert (config / "settings.json").read_text() == '{"_": "user-original"}'
    assert not (config / "settings.json.bak").exists()
    assert not (config / "agents").exists()
    # Records are still produced (so the manifest dry-run can report intent).
    assert len(records) == 2
    settings_rec = next(r for r in records if r["dst"].endswith("settings.json"))
    assert settings_rec["action"] == "overwrite"
    assert settings_rec["backup"] == str(config / "settings.json.bak")


# write_manifest


def test_write_manifest_writes_schema_and_harness(tmp_path: Path) -> None:
    overlay = [{"dst": "/c/settings.json", "src": "root/claude/settings.json", "backup": None, "action": "create"}]
    install.write_manifest(tmp_path, "claude", overlay, ["dock"], [{"name": "fixer"}], dry_run=False)

    data = json.loads((tmp_path / install.MANIFEST_FILE).read_text())
    assert data["schema"] == install.MANIFEST_SCHEMA
    assert set(data["harnesses"]) == {"claude"}
    claude = data["harnesses"]["claude"]
    assert claude["overlay"] == overlay
    assert claude["marketplaces"] == ["dock"]
    assert claude["plugins"] == [{"name": "fixer"}]
    assert "installed_at" in claude


def test_write_manifest_merges_across_harnesses(tmp_path: Path) -> None:
    install.write_manifest(tmp_path, "claude", [], ["dock"], [], dry_run=False)
    install.write_manifest(tmp_path, "gemini", [], [], [], dry_run=False)

    data = json.loads((tmp_path / install.MANIFEST_FILE).read_text())
    # Both keys survive the second write — cross-harness merge.
    assert set(data["harnesses"]) == {"claude", "gemini"}


def test_write_manifest_replaces_same_harness(tmp_path: Path) -> None:
    install.write_manifest(tmp_path, "claude", [], ["dock"], [], dry_run=False)
    install.write_manifest(tmp_path, "claude", [], ["chrome", "dock"], [], dry_run=False)

    data = json.loads((tmp_path / install.MANIFEST_FILE).read_text())
    assert data["harnesses"]["claude"]["marketplaces"] == ["chrome", "dock"]


def test_write_manifest_dry_run_writes_nothing(tmp_path: Path) -> None:
    install.write_manifest(tmp_path, "claude", [], [], [], dry_run=True)
    assert not (tmp_path / install.MANIFEST_FILE).exists()


# _load_manifest


def test_load_manifest_skeleton_when_missing(tmp_path: Path) -> None:
    manifest = install._load_manifest(tmp_path)
    assert manifest == {"schema": install.MANIFEST_SCHEMA, "harnesses": {}}


def test_load_manifest_skeleton_when_corrupt(tmp_path: Path) -> None:
    (tmp_path / install.MANIFEST_FILE).write_text("not json{")
    manifest = install._load_manifest(tmp_path)
    assert manifest == {"schema": install.MANIFEST_SCHEMA, "harnesses": {}}


def test_load_manifest_reads_valid(tmp_path: Path) -> None:
    payload = {"schema": 1, "harnesses": {"claude": {"overlay": []}}}
    (tmp_path / install.MANIFEST_FILE).write_text(json.dumps(payload))
    assert install._load_manifest(tmp_path) == payload


# install_for


def test_install_for_returns_1_when_harness_not_on_path(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with patch("install.shutil.which", return_value=None):
        rc = install.install_for("claude", dry_run=False)
    assert rc == 1
    assert "not on PATH" in capsys.readouterr().err


def test_install_for_dry_run_returns_0() -> None:
    with patch("install.shutil.which", return_value="/usr/bin/claude"):
        rc = install.install_for("claude", dry_run=True)
    assert rc == 0


def test_install_for_returns_1_when_all_marketplaces_fail() -> None:
    with (
        patch("install.shutil.which", return_value="/usr/bin/claude"),
        patch("install.bootstrap_workspace"),
        patch("install.copy_overlay", return_value=(True, "", [])),
        patch("install.write_manifest"),
        patch("install.register_marketplace", return_value=(False, "boom")),
    ):
        rc = install.install_for("claude", dry_run=False)
    assert rc == 1


def test_install_for_invokes_install_plugin_per_spec() -> None:
    fake_specs = [
        install.PluginSpec(name="git", source_path=Path("/x/git")),
        install.PluginSpec(name="gh", source_path=Path("/x/gh")),
    ]
    with (
        patch("install.shutil.which", return_value="/usr/bin/claude"),
        patch("install.bootstrap_workspace"),
        patch("install.copy_overlay", return_value=(True, "", [])),
        patch("install.write_manifest"),
        patch("install.register_marketplace", return_value=(True, "")),
        patch("install.read_plugin_specs", return_value=fake_specs),
        patch("install.install_plugin", return_value=(True, "")) as mock_install,
    ):
        rc = install.install_for("claude", dry_run=False)
    assert rc == 0
    # 5 racks x 2 specs = 10 calls
    assert mock_install.call_count == 10


def test_install_for_returns_1_when_overlay_fails() -> None:
    with (
        patch("install.shutil.which", return_value="/usr/bin/claude"),
        patch("install.bootstrap_workspace"),
        patch("install.copy_overlay", return_value=(False, "overlay copy failed: boom", [])),
    ):
        rc = install.install_for("claude", dry_run=False)
    assert rc == 1


def test_install_for_records_overlay_in_manifest() -> None:
    overlay = [{"dst": "/c/x", "src": "root/claude/x", "backup": None, "action": "create"}]
    with (
        patch("install.shutil.which", return_value="/usr/bin/claude"),
        patch("install.bootstrap_workspace"),
        patch("install.copy_overlay", return_value=(True, "", overlay)),
        patch("install.register_marketplace", return_value=(True, "")),
        patch("install.read_plugin_specs", return_value=[]),
        patch("install.write_manifest") as mock_write,
    ):
        install.install_for("claude", dry_run=False)
    # The overlay records returned by copy_overlay are threaded into write_manifest.
    args, _ = mock_write.call_args
    assert args[0] == install.REPO_ROOT
    assert args[1] == "claude"
    assert args[2] == overlay
