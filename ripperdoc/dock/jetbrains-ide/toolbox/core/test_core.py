"""Tests for the cross-platform core surface (not mac-specific).

Two guarantees: the Linux/Windows stubs raise NotImplementedError for every
entry point, and the public API re-exported from `core` is wired to the running
platform's impl (this host is darwin, so the jetbrains_mac functions).
"""

import sys

import pytest

import core
from core import jetbrains_linux, jetbrains_mac, jetbrains_windows


@pytest.mark.parametrize("stub", [jetbrains_linux, jetbrains_windows], ids=["linux", "windows"])
def test_stub_in_jetbrains_raises_not_implemented(stub: object) -> None:
    with pytest.raises(NotImplementedError):
        stub.in_jetbrains()  # type: ignore[attr-defined]


@pytest.mark.parametrize("stub", [jetbrains_linux, jetbrains_windows], ids=["linux", "windows"])
def test_stub_resolve_exec_path_raises_not_implemented(stub: object) -> None:
    with pytest.raises(NotImplementedError):
        stub.resolve_exec_path()  # type: ignore[attr-defined]


@pytest.mark.parametrize("stub", [jetbrains_linux, jetbrains_windows], ids=["linux", "windows"])
def test_stub_resolve_log_dir_raises_not_implemented(stub: object) -> None:
    with pytest.raises(NotImplementedError):
        stub.resolve_log_dir()  # type: ignore[attr-defined]


def test_public_api_is_importable() -> None:
    from core import (  # noqa: F401
        JetBrainsError,
        in_jetbrains,
        launch,
        preview_url,
        reap_later,
        resolve_exec_path,
        resolve_log_dir,
        set_preview,
    )

    assert set(core.__all__) == {
        "JetBrainsError",
        "in_jetbrains",
        "resolve_exec_path",
        "resolve_log_dir",
        "launch",
        "reap_later",
        "set_preview",
        "preview_url",
    }


def test_public_api_wired_to_mac_on_darwin() -> None:
    assert sys.platform == "darwin"
    assert core.in_jetbrains is jetbrains_mac.in_jetbrains
    assert core.resolve_exec_path is jetbrains_mac.resolve_exec_path
    assert core.resolve_log_dir is jetbrains_mac.resolve_log_dir
