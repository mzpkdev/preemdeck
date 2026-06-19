"""Tests for the cross-platform core surface (not mac-specific).

Two guarantees: the Linux/Windows stubs raise NotImplementedError for every
entry point, and the public API re-exported from `core` is wired to the running
platform's impl (this host is darwin, so the _mac functions).
"""

import sys

import pytest

import core
from core import _linux, _mac, _windows


@pytest.mark.parametrize("stub", [_linux, _windows], ids=["linux", "windows"])
def test_stub_in_jetbrains_raises_not_implemented(stub: object) -> None:
    with pytest.raises(NotImplementedError):
        stub.in_jetbrains()  # type: ignore[attr-defined]


@pytest.mark.parametrize("stub", [_linux, _windows], ids=["linux", "windows"])
def test_stub_resolve_exec_path_raises_not_implemented(stub: object) -> None:
    with pytest.raises(NotImplementedError):
        stub.resolve_exec_path()  # type: ignore[attr-defined]


@pytest.mark.parametrize("stub", [_linux, _windows], ids=["linux", "windows"])
def test_stub_resolve_log_dir_raises_not_implemented(stub: object) -> None:
    with pytest.raises(NotImplementedError):
        stub.resolve_log_dir()  # type: ignore[attr-defined]


def test_public_api_is_importable() -> None:
    from core import (  # noqa: F401
        JetBrainsError,
        in_jetbrains,
        resolve_exec_path,
        resolve_log_dir,
    )

    assert set(core.__all__) == {
        "JetBrainsError",
        "in_jetbrains",
        "resolve_exec_path",
        "resolve_log_dir",
    }


def test_public_api_wired_to_mac_on_darwin() -> None:
    assert sys.platform == "darwin"
    assert core.in_jetbrains is _mac.in_jetbrains
    assert core.resolve_exec_path is _mac.resolve_exec_path
    assert core.resolve_log_dir is _mac.resolve_log_dir
