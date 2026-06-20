"""Tests for read_logs — hermetic: read_logs.resolve_log_dir is monkeypatched to
a tmp dir holding a written idea.log, so nothing ever touches a real IDE.

read_logs(n) returns the last n lines; main wraps it in an argparse CLI, printing
the lines newline-joined to stdout and mapping IdeaError / OSError to exit
code 1. A non-int `n` is an argparse usage error (exit 2).
"""

from pathlib import Path

import pytest
import read_logs
from read_logs import read_logs as read_logs_fn


@pytest.fixture(autouse=True)
def _in_idea(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default the CLI's in_idea() gate to True so main() tests are hermetic.

    main() now fails fast outside a JetBrains terminal; without this the suite
    would depend on the ambient shell. Gate-firing is covered explicitly below.
    """
    monkeypatch.setattr(read_logs, "in_idea", lambda: True)


def _write_log(tmp_path: Path, lines: list[str]) -> Path:
    """Write `lines` to tmp_path/idea.log (newline-terminated) and return tmp_path."""
    (tmp_path / "idea.log").write_text("".join(f"{line}\n" for line in lines))
    return tmp_path


# --- read_logs --------------------------------------------------------------


def test_read_logs_returns_last_n_lines_in_order(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    log_dir = _write_log(tmp_path, ["one", "two", "three", "four", "five"])
    monkeypatch.setattr(read_logs, "resolve_log_dir", lambda: log_dir)
    assert read_logs_fn(3) == ["three", "four", "five"]


def test_read_logs_n_larger_than_file_returns_all_lines(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    lines = ["alpha", "bravo", "charlie"]
    log_dir = _write_log(tmp_path, lines)
    monkeypatch.setattr(read_logs, "resolve_log_dir", lambda: log_dir)
    assert read_logs_fn(999) == lines


def test_read_logs_default_returns_last_50(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    lines = [f"line-{i}" for i in range(120)]
    log_dir = _write_log(tmp_path, lines)
    monkeypatch.setattr(read_logs, "resolve_log_dir", lambda: log_dir)
    result = read_logs_fn()
    assert len(result) == 50
    assert result == lines[-50:]


def test_read_logs_propagates_idea_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom() -> Path:
        raise read_logs.IdeaError("no IDE")

    monkeypatch.setattr(read_logs, "resolve_log_dir", boom)
    with pytest.raises(read_logs.IdeaError):
        read_logs_fn(5)


# --- main -------------------------------------------------------------------


def test_main_no_args_prints_last_50_and_returns_0(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    lines = [f"line-{i}" for i in range(60)]
    log_dir = _write_log(tmp_path, lines)
    monkeypatch.setattr(read_logs, "resolve_log_dir", lambda: log_dir)

    assert read_logs.main([]) == 0
    out = capsys.readouterr()
    assert out.out.splitlines() == lines[-50:]
    assert out.err == ""


def test_main_with_n_arg_prints_last_n_and_returns_0(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    log_dir = _write_log(tmp_path, ["a", "b", "c", "d"])
    monkeypatch.setattr(read_logs, "resolve_log_dir", lambda: log_dir)

    assert read_logs.main(["3"]) == 0
    out = capsys.readouterr()
    assert out.out.splitlines() == ["b", "c", "d"]
    assert out.err == ""


def test_main_prints_lines_newline_joined(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    log_dir = _write_log(tmp_path, ["a", "b", "c", "d"])
    monkeypatch.setattr(read_logs, "resolve_log_dir", lambda: log_dir)

    assert read_logs.main(["3"]) == 0
    out = capsys.readouterr()
    assert out.out == "b\nc\nd\n"


def test_main_returns_1_on_idea_error_and_prints_nothing_to_stdout(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def boom() -> Path:
        raise read_logs.IdeaError("no IDE")

    monkeypatch.setattr(read_logs, "resolve_log_dir", boom)

    assert read_logs.main([]) == 1
    out = capsys.readouterr()
    assert out.out == ""
    assert "read_logs:" in out.err


def test_main_outside_jetbrains_returns_1_before_work(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # Cheap CLI gate: outside a JetBrains terminal in_idea() is False, so main()
    # exits 1 with the canonical resolver message and never reaches resolve_log_dir().
    monkeypatch.setattr(read_logs, "in_idea", lambda: False)

    def boom() -> Path:
        raise AssertionError("resolve_log_dir must not be reached when the gate fires")

    monkeypatch.setattr(read_logs, "resolve_log_dir", boom)
    assert read_logs.main([]) == 1
    out = capsys.readouterr()
    assert out.out == ""
    assert "read_logs: no JetBrains IDE in the process ancestry" in out.err


def test_main_exits_2_on_non_int_arg(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    log_dir = _write_log(tmp_path, ["x", "y"])
    monkeypatch.setattr(read_logs, "resolve_log_dir", lambda: log_dir)

    with pytest.raises(SystemExit) as excinfo:
        read_logs.main(["abc"])
    assert excinfo.value.code == 2
    out = capsys.readouterr()
    assert out.out == ""
    assert "usage:" in out.err
