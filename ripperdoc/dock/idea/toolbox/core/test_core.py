"""Tests for the cross-platform core surface (not mac-specific).

Two guarantees: the Linux/Windows stubs raise NotImplementedError for every
entry point, and the public API re-exported from `core` is wired to the running
platform's impl (this host is darwin, so the idea_mac functions).
"""

import sys

import pytest

import core
from core import idea_linux, idea_mac, idea_windows


@pytest.mark.parametrize("stub", [idea_linux, idea_windows], ids=["linux", "windows"])
def test_stub_in_idea_raises_not_implemented(stub: object) -> None:
    with pytest.raises(NotImplementedError):
        stub.in_idea()  # type: ignore[attr-defined]


@pytest.mark.parametrize("stub", [idea_linux, idea_windows], ids=["linux", "windows"])
def test_stub_resolve_exec_path_raises_not_implemented(stub: object) -> None:
    with pytest.raises(NotImplementedError):
        stub.resolve_exec_path()  # type: ignore[attr-defined]


@pytest.mark.parametrize("stub", [idea_linux, idea_windows], ids=["linux", "windows"])
def test_stub_resolve_log_dir_raises_not_implemented(stub: object) -> None:
    with pytest.raises(NotImplementedError):
        stub.resolve_log_dir()  # type: ignore[attr-defined]


def test_public_api_is_importable() -> None:
    from core import (  # noqa: F401
        IdeaError,
        in_idea,
        launch,
        preview_url,
        reap_later,
        resolve_exec_path,
        resolve_log_dir,
        set_preview,
    )

    assert set(core.__all__) == {
        "IdeaError",
        "in_idea",
        "resolve_exec_path",
        "resolve_log_dir",
        "launch",
        "reap_later",
        "set_preview",
        "preview_url",
    }


def test_public_api_wired_to_mac_on_darwin() -> None:
    assert sys.platform == "darwin"
    assert core.in_idea is idea_mac.in_idea
    assert core.resolve_exec_path is idea_mac.resolve_exec_path
    assert core.resolve_log_dir is idea_mac.resolve_log_dir
