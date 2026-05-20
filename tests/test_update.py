"""Tests for update.py"""

from pathlib import Path

import pytest

import update

# detect_harness


def test_detect_harness_claude(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(update, "REPO_ROOT", Path("/home/u/.claude"))
    assert update.detect_harness() == "claude"


def test_detect_harness_codex(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(update, "REPO_ROOT", Path("/home/u/.codex"))
    assert update.detect_harness() == "codex"


def test_detect_harness_gemini(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(update, "REPO_ROOT", Path("/home/u/.gemini"))
    assert update.detect_harness() == "gemini"


def test_detect_harness_exits_when_undotted_unknown(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(update, "REPO_ROOT", Path("/home/u/preemdeck"))
    with pytest.raises(SystemExit) as exc_info:
        update.detect_harness()
    assert exc_info.value.code == 1
    assert "Cannot infer harness" in capsys.readouterr().err


def test_detect_harness_exits_when_dotted_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(update, "REPO_ROOT", Path("/home/u/.weird"))
    with pytest.raises(SystemExit):
        update.detect_harness()
