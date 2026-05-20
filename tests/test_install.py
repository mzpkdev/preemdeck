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
        patch("install.unpack_harness", return_value=(True, "")),
        patch("install.cleanup_after_install", return_value=0),
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
        patch("install.unpack_harness", return_value=(True, "")),
        patch("install.cleanup_after_install", return_value=0),
        patch("install.register_marketplace", return_value=(True, "")),
        patch("install.read_plugin_specs", return_value=fake_specs),
        patch("install.install_plugin", return_value=(True, "")) as mock_install,
    ):
        rc = install.install_for("claude", dry_run=False)
    assert rc == 0
    # 5 racks x 2 specs = 10 calls
    assert mock_install.call_count == 10


def test_install_for_returns_1_when_unpack_fails() -> None:
    with (
        patch("install.shutil.which", return_value="/usr/bin/claude"),
        patch("install.unpack_harness", return_value=(False, "missing root/claude/")),
    ):
        rc = install.install_for("claude", dry_run=False)
    assert rc == 1


# unpack_harness


def _seed_all_sources(repo_root: Path) -> None:
    root = repo_root / "root"
    (root / "claude" / "agents").mkdir(parents=True)
    (root / "claude" / "settings.json").write_text('{"_": "claude"}')
    (root / "claude" / "agents" / "fixer.md").write_text("# fixer-md")
    (root / "codex" / "agents").mkdir(parents=True)
    (root / "codex" / "config.toml").write_text('_ = "codex"\n')
    (root / "codex" / "agents" / "fixer.toml").write_text('description = "fixer-toml"\n')
    (root / "gemini" / "agents").mkdir(parents=True)
    (root / "gemini" / "settings.json").write_text('{"_": "gemini"}')
    (root / "gemini" / "agents" / "fixer.md").write_text("# fixer-md-gemini")


def test_unpack_claude_moves_tree_to_repo_root(tmp_path: Path) -> None:
    _seed_all_sources(tmp_path)
    ok, msg = install.unpack_harness("claude", tmp_path, dry_run=False)
    assert (ok, msg) == (True, "")
    assert (tmp_path / "settings.json").read_text() == '{"_": "claude"}'
    assert (tmp_path / "agents" / "fixer.md").read_text() == "# fixer-md"
    for host in install.HOSTS:
        assert not (tmp_path / "root" / host).exists()


def test_unpack_gemini_moves_tree_to_repo_root(tmp_path: Path) -> None:
    _seed_all_sources(tmp_path)
    ok, msg = install.unpack_harness("gemini", tmp_path, dry_run=False)
    assert (ok, msg) == (True, "")
    assert (tmp_path / "settings.json").read_text() == '{"_": "gemini"}'
    assert (tmp_path / "agents" / "fixer.md").read_text() == "# fixer-md-gemini"
    for host in install.HOSTS:
        assert not (tmp_path / "root" / host).exists()


def test_unpack_codex_moves_tree_to_repo_root(tmp_path: Path) -> None:
    _seed_all_sources(tmp_path)
    ok, msg = install.unpack_harness("codex", tmp_path, dry_run=False)
    assert (ok, msg) == (True, "")
    assert (tmp_path / "config.toml").read_text() == '_ = "codex"\n'
    assert (tmp_path / "agents" / "fixer.toml").read_text() == 'description = "fixer-toml"\n'
    assert not (tmp_path / "settings.json").exists()
    for host in install.HOSTS:
        assert not (tmp_path / "root" / host).exists()


def test_unpack_dry_run_is_noop(tmp_path: Path) -> None:
    _seed_all_sources(tmp_path)
    ok, msg = install.unpack_harness("claude", tmp_path, dry_run=True)
    assert (ok, msg) == (True, "")
    assert (tmp_path / "root" / "claude" / "settings.json").exists()
    assert (tmp_path / "root" / "codex" / "config.toml").exists()
    assert (tmp_path / "root" / "gemini" / "settings.json").exists()
    assert not (tmp_path / "settings.json").exists()


def test_unpack_idempotent_when_already_done(tmp_path: Path) -> None:
    (tmp_path / "settings.json").write_text('{"already": "done"}')
    ok, msg = install.unpack_harness("claude", tmp_path, dry_run=False)
    assert (ok, msg) == (True, "")
    assert (tmp_path / "settings.json").read_text() == '{"already": "done"}'


def test_unpack_noop_when_clean_dir(tmp_path: Path) -> None:
    ok, msg = install.unpack_harness("claude", tmp_path, dry_run=False)
    assert (ok, msg) == (True, "")
    assert not (tmp_path / "settings.json").exists()


def test_unpack_fails_when_wrong_harness_staging_present(tmp_path: Path) -> None:
    (tmp_path / "root" / "gemini").mkdir(parents=True)
    (tmp_path / "root" / "gemini" / "settings.json").write_text('{"_": "gemini"}')
    ok, msg = install.unpack_harness("claude", tmp_path, dry_run=False)
    assert ok is False
    assert "root/claude/" in msg
    assert "root/gemini/" in msg
    assert (tmp_path / "root" / "gemini" / "settings.json").exists()


def test_unpack_overwrites_existing_destination(tmp_path: Path) -> None:
    _seed_all_sources(tmp_path)
    (tmp_path / "agents").mkdir()
    (tmp_path / "agents" / "fixer.md").write_text("# stale-fixer")
    ok, msg = install.unpack_harness("claude", tmp_path, dry_run=False)
    assert (ok, msg) == (True, "")
    assert (tmp_path / "agents" / "fixer.md").read_text() == "# fixer-md"


# cleanup_after_install


def test_cleanup_no_manifest_returns_zero(tmp_path: Path) -> None:
    assert install.cleanup_after_install(tmp_path, dry_run=False) == 0


def test_cleanup_removes_files(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text("[tool]")
    (tmp_path / "uv.lock").write_text("locked")
    (tmp_path / "keep.txt").write_text("keep")
    (tmp_path / ".trash").write_text("pyproject.toml\nuv.lock\n")
    removed = install.cleanup_after_install(tmp_path, dry_run=False)
    assert removed == 2
    assert not (tmp_path / "pyproject.toml").exists()
    assert not (tmp_path / "uv.lock").exists()
    assert (tmp_path / "keep.txt").exists()


def test_cleanup_removes_directories(tmp_path: Path) -> None:
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "a.py").write_text("a")
    (tmp_path / "tests" / "sub").mkdir()
    (tmp_path / "tests" / "sub" / "b.py").write_text("b")
    (tmp_path / ".trash").write_text("tests/\n")
    removed = install.cleanup_after_install(tmp_path, dry_run=False)
    assert removed == 1
    assert not (tmp_path / "tests").exists()


def test_cleanup_glob_pattern_matches_multiple(tmp_path: Path) -> None:
    (tmp_path / "scripts").mkdir()
    (tmp_path / "scripts" / "__pycache__").mkdir()
    (tmp_path / "scripts" / "__pycache__" / "x.pyc").write_text("x")
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "__pycache__").mkdir()
    (tmp_path / ".trash").write_text("**/__pycache__/\n")
    removed = install.cleanup_after_install(tmp_path, dry_run=False)
    assert removed == 2
    assert not (tmp_path / "scripts" / "__pycache__").exists()
    assert not (tmp_path / "tests" / "__pycache__").exists()


def test_cleanup_skips_missing(tmp_path: Path) -> None:
    (tmp_path / ".trash").write_text("does-not-exist.txt\nalso-missing/\n")
    assert install.cleanup_after_install(tmp_path, dry_run=False) == 0


def test_cleanup_refuses_absolute_path(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    sentinel = tmp_path / "sentinel.txt"
    sentinel.write_text("safe")
    (tmp_path / ".trash").write_text(f"/{sentinel}\n")
    removed = install.cleanup_after_install(tmp_path, dry_run=False)
    assert removed == 0
    assert sentinel.exists()
    assert "refusing unsafe pattern" in capsys.readouterr().err


def test_cleanup_refuses_dotdot(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    (tmp_path / ".trash").write_text("../escape\n")
    removed = install.cleanup_after_install(tmp_path, dry_run=False)
    assert removed == 0
    assert "refusing unsafe pattern" in capsys.readouterr().err


def test_cleanup_dry_run_counts_but_no_delete(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text("[tool]")
    (tmp_path / "tests").mkdir()
    (tmp_path / ".trash").write_text("pyproject.toml\ntests/\n")
    removed = install.cleanup_after_install(tmp_path, dry_run=True)
    assert removed == 2
    assert (tmp_path / "pyproject.toml").exists()
    assert (tmp_path / "tests").exists()


def test_cleanup_ignores_comments_and_blank_lines(tmp_path: Path) -> None:
    (tmp_path / "kill.txt").write_text("x")
    (tmp_path / "keep.txt").write_text("y")
    (tmp_path / ".trash").write_text("# this is a comment\n\nkill.txt  # trailing comment\n# keep.txt\n")
    removed = install.cleanup_after_install(tmp_path, dry_run=False)
    assert removed == 1
    assert not (tmp_path / "kill.txt").exists()
    assert (tmp_path / "keep.txt").exists()


def test_cleanup_skips_symlinks(tmp_path: Path) -> None:
    target = tmp_path / "real.txt"
    target.write_text("real")
    link = tmp_path / "linked.txt"
    link.symlink_to(target)
    (tmp_path / ".trash").write_text("linked.txt\n")
    removed = install.cleanup_after_install(tmp_path, dry_run=False)
    assert removed == 0
    assert link.exists()
    assert target.exists()


def test_cleanup_removes_manifest_implicitly(tmp_path: Path) -> None:
    (tmp_path / "kill.txt").write_text("x")
    (tmp_path / ".trash").write_text("kill.txt\n")
    removed = install.cleanup_after_install(tmp_path, dry_run=False)
    assert removed == 1
    assert not (tmp_path / "kill.txt").exists()
    assert not (tmp_path / ".trash").exists()


def test_cleanup_dry_run_preserves_manifest(tmp_path: Path) -> None:
    (tmp_path / ".trash").write_text("\n")
    install.cleanup_after_install(tmp_path, dry_run=True)
    assert (tmp_path / ".trash").exists()
