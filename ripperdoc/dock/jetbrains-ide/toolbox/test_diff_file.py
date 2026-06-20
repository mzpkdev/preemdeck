"""Tests for diff_file - hermetic: no real IDE, no real process spawn, no viewer.

launch is monkeypatched on the diff_file module: it records its argv plus the
`wait` flag and spawns nothing. The native --wait is launch()'s job now, so
diff_file never appends it - the stub just captures whether wait was threaded
through. With wait=True, diff_file reads the LEFT file (`target`) back off disk
after launch() returns, so a stub that wants to model an edit writes to the LEFT
file before returning; an untouched file reads back its original contents.
Inputs are real files under tmp_path so strict path resolution behaves like
production: a missing input fails fast, before any launch.
"""

from pathlib import Path

import diff_file
import pytest
from core import JetBrainsError
from diff_file import diff_file as diff_fn

RECONCILED = "RECONCILED\n"


def _stub_launch(calls: list[tuple[list[str], bool]]):
    """A launch() stub: records (argv, wait), spawns nothing, returns a dummy handle."""

    def launch(args: list[str], *, wait: bool = False) -> object:
        calls.append((args, wait))
        return object()

    return launch


def _stub_launch_writes(calls: list[tuple[list[str], bool]], target: Path, text: str = RECONCILED):
    """A launch() stub that models a user edit: writes `text` to the LEFT file
    (`target`) so diff_file's wait=True read-back returns it. Records (argv, wait)."""

    def launch(args: list[str], *, wait: bool = False) -> object:
        calls.append((args, wait))
        if wait:
            target.write_text(text)
        return object()

    return launch


def _make_inputs(tmp_path: Path) -> tuple[Path, Path]:
    target = tmp_path / "target.py"
    suggestion = tmp_path / "suggestion.py"
    target.write_text("a\n")
    suggestion.write_text("b\n")
    return target, suggestion


# --- diff launch (argv shape) -----------------------------------------------


def test_diff_threads_resolved_paths_into_argv(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[tuple[list[str], bool]] = []
    monkeypatch.setattr(diff_file, "launch", _stub_launch(calls))

    target, suggestion = _make_inputs(tmp_path)

    diff_fn(str(target), str(suggestion))
    # "diff" subcommand first, both args resolved to absolute, order preserved.
    # Default is async, so launch is handed wait=False and no --wait in argv.
    assert calls == [(["diff", str(target.resolve()), str(suggestion.resolve())], False)]
    assert "--wait" not in calls[0][0]


# --- watched pane (the key contract) ----------------------------------------


def test_diff_two_way_watches_left(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[tuple[list[str], bool]] = []
    target, suggestion = _make_inputs(tmp_path)
    # Stub models an edit to the LEFT file; diff_file reads it back on wait=True.
    monkeypatch.setattr(diff_file, "launch", _stub_launch_writes(calls, target))

    # 2-way watches the LEFT pane (`target`): its post-edit contents come back.
    assert diff_fn(str(target), str(suggestion), wait=True) == RECONCILED


def test_diff_wait_reads_left_back_off_disk(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[tuple[list[str], bool]] = []
    target, suggestion = _make_inputs(tmp_path)
    monkeypatch.setattr(diff_file, "launch", _stub_launch_writes(calls, target, "AFTER EDIT\n"))

    # wait=True returns exactly the LEFT file's contents as they are after launch().
    assert diff_fn(str(target), str(suggestion), wait=True) == "AFTER EDIT\n"
    # launch was asked to block (wait=True) - that's how the native --wait fires.
    assert calls == [(["diff", str(target.resolve()), str(suggestion.resolve())], True)]


def test_diff_wait_untouched_left_returns_original(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[tuple[list[str], bool]] = []
    monkeypatch.setattr(diff_file, "launch", _stub_launch(calls))

    target, suggestion = _make_inputs(tmp_path)

    # No edit happened (plain stub): wait=True still reads the LEFT file, which is
    # unchanged, so we get its original contents back.
    assert diff_fn(str(target), str(suggestion), wait=True) == "a\n"


# --- wait gating ------------------------------------------------------------


def test_diff_no_wait_launches_only_returns_none(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[tuple[list[str], bool]] = []
    monkeypatch.setattr(diff_file, "launch", _stub_launch(calls))

    target, suggestion = _make_inputs(tmp_path)

    # Default (wait=False): launch only with wait=False, no read-back, returns None.
    assert diff_fn(str(target), str(suggestion)) is None
    assert calls == [(["diff", str(target.resolve()), str(suggestion.resolve())], False)]


def test_diff_passes_wait_flag_through(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[tuple[list[str], bool]] = []
    target, suggestion = _make_inputs(tmp_path)
    monkeypatch.setattr(diff_file, "launch", _stub_launch_writes(calls, target))

    # wait=wait is threaded straight into launch().
    diff_fn(str(target), str(suggestion), wait=True)
    assert calls[0][1] is True


# --- strict input validation (fail fast, before launch) ---------------------


def test_diff_missing_input_raises_file_not_found(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[tuple[list[str], bool]] = []
    monkeypatch.setattr(diff_file, "launch", _stub_launch(calls))

    target = tmp_path / "target.py"
    target.write_text("a\n")
    missing = tmp_path / "nope.py"

    # strict=True -> a missing input fails before anything is launched.
    with pytest.raises(FileNotFoundError):
        diff_fn(str(target), str(missing))
    assert calls == []


# --- main() argv handling ---------------------------------------------------


def test_main_two_files_invokes_diff(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[tuple[list[str], bool]] = []
    monkeypatch.setattr(diff_file, "launch", _stub_launch(calls))

    target, suggestion = _make_inputs(tmp_path)

    assert diff_file.main([str(target), str(suggestion)]) == 0
    assert calls == [(["diff", str(target.resolve()), str(suggestion.resolve())], False)]


def test_main_no_wait_prints_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    calls: list[tuple[list[str], bool]] = []
    monkeypatch.setattr(diff_file, "launch", _stub_launch(calls))

    target, suggestion = _make_inputs(tmp_path)

    # No --wait -> fire-and-forget: launch with wait=False, None outcome, nothing printed.
    assert diff_file.main([str(target), str(suggestion)]) == 0
    assert calls == [(["diff", str(target.resolve()), str(suggestion.resolve())], False)]
    assert capsys.readouterr().out == ""


def test_main_wait_prints_left_contents(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    calls: list[tuple[list[str], bool]] = []
    target, suggestion = _make_inputs(tmp_path)
    monkeypatch.setattr(diff_file, "launch", _stub_launch_writes(calls, target, RECONCILED))

    # --wait -> launch blocks (wait=True), 2-way reads LEFT back, main prints it verbatim.
    assert diff_file.main([str(target), str(suggestion), "--wait"]) == 0
    assert calls[0][1] is True
    assert capsys.readouterr().out == RECONCILED


def test_main_missing_input_returns_1(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(diff_file, "launch", _stub_launch([]))

    target = tmp_path / "target.py"
    target.write_text("a\n")
    missing = tmp_path / "nope.py"

    # FileNotFoundError is an OSError subclass -> rides main's except -> exit 1.
    assert diff_file.main([str(target), str(missing)]) == 1


def test_main_no_live_ide_returns_1(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # launch() is the single live-IDE guard: it raises JetBrainsError -> exit 1.
    def boom(args: list[str], *, wait: bool = False) -> object:
        raise JetBrainsError("no live IDE")

    monkeypatch.setattr(diff_file, "launch", boom)

    target, suggestion = _make_inputs(tmp_path)

    assert diff_file.main([str(target), str(suggestion)]) == 1
    assert "diff_file:" in capsys.readouterr().err


@pytest.mark.parametrize(
    "argv",
    [
        [],
        ["/x/only.py"],
        ["/x/a.py", "/x/b.py", "/x/c.py"],
    ],
)
def test_main_wrong_arg_count_exits_2(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], argv: list[str]
) -> None:
    calls: list[tuple[list[str], bool]] = []
    monkeypatch.setattr(diff_file, "launch", _stub_launch(calls))

    # Exactly 2 positionals are valid; 0, 1, and 3+ are usage errors: argparse exits 2
    # (SystemExit) and launch is never reached.
    with pytest.raises(SystemExit) as exc:
        diff_file.main(argv)
    assert exc.value.code == 2
    assert calls == []
    assert "usage: diff_file.py" in capsys.readouterr().err
