"""Tests for core.idea_mac — fixtures captured live under WebStorm this session.

resolve_exec_path() walks the process ancestry via `ps`; both `subprocess.run`
and `os.getpid` are monkeypatched on the core.idea_mac module so the walk is
hermetic. resolve_log_dir() is exercised against a fake JetBrains log tree under
a tmp HOME, with mtimes set so the newest matching product dir wins.
"""

import os
import types
from collections.abc import Callable
from pathlib import Path

import pytest

from core import IdeaError, idea_mac, in_idea, resolve_exec_path

WEBSTORM = "/Applications/WebStorm.app/Contents/MacOS/webstorm"

# Real ancestry observed under WebStorm: pid -> (ppid, exe).
# The leaf is Python.app (also a .app/Contents/MacOS path) and must be skipped.
ANCESTRY = {
    7539: (
        7537,
        "/opt/homebrew/Cellar/python@3.14/3.14.5/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python",
    ),
    7537: (81159, "/bin/zsh"),
    81159: (24643, "claude"),
    24643: (57130, "/bin/zsh"),
    57130: (1, WEBSTORM),
}

# A chain with no JetBrains binary: zsh -> launchd -> pid 1.
NO_IDE = {
    4242: (4241, "/bin/zsh"),
    4241: (1, "/sbin/launchd"),
}


def _fake_ps(ancestry: dict[int, tuple[int, str]]) -> Callable[..., types.SimpleNamespace]:
    """Build a fake subprocess.run keyed off the pid in `cmd[-1]`."""

    def run(cmd: list[str], **_kwargs: object) -> types.SimpleNamespace:
        ppid, exe = ancestry.get(int(cmd[-1]), (1, ""))
        return types.SimpleNamespace(stdout=f"{ppid} {exe}\n")

    return run


def test_in_idea_true_via_bundle_id(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("__CFBundleIdentifier", "com.jetbrains.WebStorm")
    monkeypatch.delenv("TERMINAL_EMULATOR", raising=False)
    assert in_idea() is True


def test_in_idea_true_via_terminal_emulator(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("__CFBundleIdentifier", raising=False)
    monkeypatch.setenv("TERMINAL_EMULATOR", "JetBrains-JediTerm")
    assert in_idea() is True


def test_in_idea_false_when_neither_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("__CFBundleIdentifier", raising=False)
    monkeypatch.delenv("TERMINAL_EMULATOR", raising=False)
    assert in_idea() is False


def test_resolve_exec_path_walks_ancestry_to_webstorm(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(idea_mac.os, "getpid", lambda: 7539)
    monkeypatch.setattr(idea_mac.subprocess, "run", _fake_ps(ANCESTRY))
    assert resolve_exec_path() == WEBSTORM


def test_resolve_exec_path_skips_python_app_ancestor(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(idea_mac.os, "getpid", lambda: 7539)
    monkeypatch.setattr(idea_mac.subprocess, "run", _fake_ps(ANCESTRY))
    assert "Python.app" not in resolve_exec_path()


def test_resolve_exec_path_raises_without_jetbrains_in_chain(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(idea_mac.os, "getpid", lambda: 4242)
    monkeypatch.setattr(idea_mac.subprocess, "run", _fake_ps(NO_IDE))
    with pytest.raises(IdeaError):
        resolve_exec_path()


def test_resolve_log_dir_picks_active_product_newest_version(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(idea_mac, "resolve_exec_path", lambda: "/x/WebStorm.app/Contents/MacOS/webstorm")
    monkeypatch.setenv("HOME", str(tmp_path))
    base = tmp_path / "Library/Logs/JetBrains"
    newest = base / "WebStorm2025.3"
    older = base / "WebStorm2025.1"
    other = base / "PyCharm2024.3"
    for d in (newest, older, other):
        d.mkdir(parents=True)
    # mtimes: WebStorm2025.3 newest, PyCharm2024.3 newer still but wrong product.
    os.utime(older, (1_000, 1_000))
    os.utime(newest, (2_000, 2_000))
    os.utime(other, (3_000, 3_000))
    assert idea_mac.resolve_log_dir() == newest


def test_resolve_log_dir_raises_when_no_dir_matches_product(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # Running product is GoLand, but the only log dir on disk is PyCharm's.
    monkeypatch.setattr(idea_mac, "resolve_exec_path", lambda: "/x/GoLand.app/Contents/MacOS/goland")
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / "Library/Logs/JetBrains/PyCharm2024.3").mkdir(parents=True)
    with pytest.raises(IdeaError):
        idea_mac.resolve_log_dir()
