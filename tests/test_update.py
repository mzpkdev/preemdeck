"""Tests for update.py"""

import json
from pathlib import Path

import pytest

import install
import update

# installed_harnesses


def _write_manifest(repo_root: Path, payload: dict) -> None:
    (repo_root / install.MANIFEST_FILE).write_text(json.dumps(payload))


def test_installed_harnesses_returns_manifest_keys(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(update, "REPO_ROOT", tmp_path)
    _write_manifest(
        tmp_path,
        {"schema": install.MANIFEST_SCHEMA, "harnesses": {"claude": {}, "gemini": {}}},
    )
    assert sorted(update.installed_harnesses()) == ["claude", "gemini"]


def test_installed_harnesses_exits_when_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(update, "REPO_ROOT", tmp_path)
    with pytest.raises(SystemExit) as exc_info:
        update.installed_harnesses()
    assert exc_info.value.code == 1
    assert "no install manifest" in capsys.readouterr().err


def test_installed_harnesses_exits_when_empty(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(update, "REPO_ROOT", tmp_path)
    _write_manifest(tmp_path, {"schema": install.MANIFEST_SCHEMA, "harnesses": {}})
    with pytest.raises(SystemExit) as exc_info:
        update.installed_harnesses()
    assert exc_info.value.code == 1


def test_installed_harnesses_exits_on_bad_schema(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(update, "REPO_ROOT", tmp_path)
    _write_manifest(tmp_path, {"schema": 2, "harnesses": {"claude": {}}})
    with pytest.raises(SystemExit) as exc_info:
        update.installed_harnesses()
    assert exc_info.value.code == 1


def test_installed_harnesses_exits_on_corrupt(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(update, "REPO_ROOT", tmp_path)
    (tmp_path / install.MANIFEST_FILE).write_text("not json{")
    with pytest.raises(SystemExit) as exc_info:
        update.installed_harnesses()
    assert exc_info.value.code == 1
