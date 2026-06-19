"""Tests for read_logs - hermetic: read_logs.resolve_log_dir is monkeypatched to
a tmp dir holding a written idea.log, so nothing ever touches a real IDE.

read_logs(n) returns the last n lines; main wraps it, printing to stdout and
mapping JetBrainsError / ValueError / OSError to exit code 1.
"""

from pathlib import Path

import pytest
import read_logs
from read_logs import read_logs as read_logs_fn


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


def test_read_logs_propagates_jetbrains_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom() -> Path:
        raise read_logs.JetBrainsError("no IDE")

    monkeypatch.setattr(read_logs, "resolve_log_dir", boom)
    with pytest.raises(read_logs.JetBrainsError):
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


def test_main_returns_1_on_jetbrains_error_and_prints_nothing_to_stdout(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def boom() -> Path:
        raise read_logs.JetBrainsError("no IDE")

    monkeypatch.setattr(read_logs, "resolve_log_dir", boom)

    assert read_logs.main([]) == 1
    out = capsys.readouterr()
    assert out.out == ""
    assert "read_logs:" in out.err


def test_main_returns_1_on_non_int_arg(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    log_dir = _write_log(tmp_path, ["x", "y"])
    monkeypatch.setattr(read_logs, "resolve_log_dir", lambda: log_dir)

    assert read_logs.main(["abc"]) == 1
    out = capsys.readouterr()
    assert out.out == ""
    assert "read_logs:" in out.err
