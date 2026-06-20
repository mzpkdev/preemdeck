"""Tests for in_idea — the CLI gate probe.

in_idea() (the predicate, imported from core) decides the result; main() wraps it
in an argparse CLI. Unlike the other suites, the in_idea() gate is the unit under
test here, so it is patched per-test rather than forced True by an autouse fixture.

Contract: main() prints "in a JetBrains IDE terminal" / "not in a JetBrains IDE
terminal" to stdout and returns 0 inside / 1 outside; -q/--quiet suppresses the
stdout line and signals through the exit code only; a NotImplementedError from an
unimplemented platform maps to a stderr note + exit 1; a bad flag is an argparse
usage error (exit 2).
"""

import pytest
import in_idea
from in_idea import main


def test_main_inside_prints_yes_and_returns_0(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(in_idea, "in_idea", lambda: True)
    assert main([]) == 0
    out = capsys.readouterr()
    assert out.out.strip() == "in a JetBrains IDE terminal"
    assert out.err == ""


def test_main_outside_prints_no_to_stdout_and_returns_1(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(in_idea, "in_idea", lambda: False)
    assert main([]) == 1
    out = capsys.readouterr()
    assert out.out.strip() == "not in a JetBrains IDE terminal"
    assert out.err == ""


def test_main_quiet_inside_silent_returns_0(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(in_idea, "in_idea", lambda: True)
    assert main(["-q"]) == 0
    out = capsys.readouterr()
    assert out.out == ""
    assert out.err == ""


def test_main_quiet_outside_silent_returns_1(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(in_idea, "in_idea", lambda: False)
    assert main(["--quiet"]) == 1
    out = capsys.readouterr()
    assert out.out == ""
    assert out.err == ""


def test_main_not_implemented_maps_to_stderr_and_exit_1(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def boom() -> bool:
        raise NotImplementedError("in_idea is not implemented for Linux yet")

    monkeypatch.setattr(in_idea, "in_idea", boom)
    assert main([]) == 1
    out = capsys.readouterr()
    assert out.out == ""
    assert "in_idea:" in out.err


def test_main_exits_2_on_unknown_flag(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as excinfo:
        main(["--nope"])
    assert excinfo.value.code == 2
    out = capsys.readouterr()
    assert "usage:" in out.err
