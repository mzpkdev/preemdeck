"""Tests for merge_file - hermetic: no real IDE, no real process spawn, no UI.

launch is monkeypatched on the merge_file module: it records its argv (NO `--wait`
- merge blocks natively, so merge_file joins the process itself) and returns a
fake Popen whose `.wait()` is a spy. To model the user hitting Apply, that
`.wait()` writes known content to the OUTPUT path = the LAST argv element, which
is exactly what merge_file reads back on wait=True. Inputs are real files under
tmp_path so strict resolution behaves like production: a missing input fails
fast, before any launch.
"""

from pathlib import Path

import merge_file
import pytest
from core import JetBrainsError
from merge_file import merge_file as merge_fn

MERGED = "MERGED\n"


class _FakePopen:
    """A fake Popen: `.wait()` is a spy that, on call, writes `text` to `output`
    (the IDE applying the merge), so merge_file's wait=True read-back returns it."""

    def __init__(self, output: str, text: str = MERGED) -> None:
        self.output = output
        self.text = text
        self.waited = False

    def wait(self) -> int:
        self.waited = True
        Path(self.output).write_text(self.text)
        return 0


def _stub_launch(calls: list[list[str]], popens: list[_FakePopen], text: str = MERGED):
    """A launch() stub: records argv, mints a _FakePopen bound to the OUTPUT (last
    argv element), stashes it for inspection, and returns it. Spawns nothing."""

    def launch(args: list[str], *, wait: bool = False) -> object:
        calls.append(args)
        popen = _FakePopen(args[-1], text)
        popens.append(popen)
        return popen

    return launch


def _make_inputs(tmp_path: Path) -> tuple[Path, Path, Path]:
    target = tmp_path / "target.py"
    suggestion = tmp_path / "suggestion.py"
    base = tmp_path / "base.py"
    target.write_text("a\n")
    suggestion.write_text("b\n")
    base.write_text("o\n")
    return target, suggestion, base


# --- merge launch (argv shape: output LAST, base THIRD, never --wait) --------


def test_merge_no_base_argv_output_last(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[list[str]] = []
    popens: list[_FakePopen] = []
    monkeypatch.setattr(merge_file, "launch", _stub_launch(calls, popens))

    target, suggestion, _ = _make_inputs(tmp_path)

    merge_fn(str(target), str(suggestion), wait=True)
    # "merge" first, inputs resolved to absolute, OUTPUT temp last. No base.
    argv = calls[0]
    assert argv[:3] == ["merge", str(target.resolve()), str(suggestion.resolve())]
    assert len(argv) == 4  # merge, target, suggestion, output
    assert argv[-1] == popens[0].output  # last element is the output temp
    assert "--wait" not in argv  # merge blocks natively; never passed --wait


def test_merge_with_base_argv_base_third_output_last(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[list[str]] = []
    popens: list[_FakePopen] = []
    monkeypatch.setattr(merge_file, "launch", _stub_launch(calls, popens))

    target, suggestion, base = _make_inputs(tmp_path)

    merge_fn(str(target), str(suggestion), str(base), wait=True)
    # base is THIRD (before output), output is LAST.
    argv = calls[0]
    assert argv[:4] == ["merge", str(target.resolve()), str(suggestion.resolve()), str(base.resolve())]
    assert len(argv) == 5  # merge, target, suggestion, base, output
    assert argv[-1] == popens[0].output
    assert "--wait" not in argv


# --- wait gating ------------------------------------------------------------


def test_merge_wait_joins_returns_output_and_cleans_up(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[list[str]] = []
    popens: list[_FakePopen] = []
    monkeypatch.setattr(merge_file, "launch", _stub_launch(calls, popens, "RESOLVED\n"))

    target, suggestion = _make_inputs(tmp_path)[:2]

    # wait=True -> proc.wait() called (we join merge ourselves), returns the
    # resolved OUTPUT content, output temp removed afterward.
    assert merge_fn(str(target), str(suggestion), wait=True) == "RESOLVED\n"
    assert popens[0].waited is True
    assert not Path(popens[0].output).exists()


def test_merge_no_wait_returns_none_schedules_reap(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[list[str]] = []
    popens: list[_FakePopen] = []
    monkeypatch.setattr(merge_file, "launch", _stub_launch(calls, popens))
    # Spy on the reap seam so nothing is actually deleted (no real thread/sleep);
    # we only assert the OUTPUT temp was *scheduled* for deferred cleanup.
    reaped: list[list[str]] = []
    monkeypatch.setattr(merge_file, "reap_later", lambda paths: reaped.append(list(paths)))

    target, suggestion = _make_inputs(tmp_path)[:2]

    # Default (wait=False): returns None, proc.wait() NOT called, output temp handed
    # to reap_later (the IDE may still write it) instead of being leaked.
    assert merge_fn(str(target), str(suggestion)) is None
    assert popens[0].waited is False
    assert reaped == [[popens[0].output]]
    # Seam is mocked, so the output temp is still on disk; clean it up ourselves.
    assert Path(popens[0].output).exists()
    Path(popens[0].output).unlink()


# --- strict input validation (fail fast, before launch) ---------------------


def test_merge_missing_input_raises_file_not_found(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[list[str]] = []
    popens: list[_FakePopen] = []
    monkeypatch.setattr(merge_file, "launch", _stub_launch(calls, popens))

    target = tmp_path / "target.py"
    target.write_text("a\n")
    missing = tmp_path / "nope.py"

    # strict=True -> a missing input fails before anything is launched.
    with pytest.raises(FileNotFoundError):
        merge_fn(str(target), str(missing))
    assert calls == []


def test_merge_missing_base_raises_file_not_found(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[list[str]] = []
    popens: list[_FakePopen] = []
    monkeypatch.setattr(merge_file, "launch", _stub_launch(calls, popens))

    target, suggestion = _make_inputs(tmp_path)[:2]
    missing = tmp_path / "nope.py"

    # A missing base is resolved strictly too -> fails before launch.
    with pytest.raises(FileNotFoundError):
        merge_fn(str(target), str(suggestion), str(missing))
    assert calls == []


# --- main() argv handling ---------------------------------------------------


def test_main_two_files_invokes_merge(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[list[str]] = []
    popens: list[_FakePopen] = []
    monkeypatch.setattr(merge_file, "launch", _stub_launch(calls, popens))
    # Mock the reap seam (no real thread/sleep); the output temp is scheduled, not leaked.
    monkeypatch.setattr(merge_file, "reap_later", lambda paths: None)

    target, suggestion = _make_inputs(tmp_path)[:2]

    # No --wait -> fire-and-forget, exit 0.
    assert merge_file.main([str(target), str(suggestion)]) == 0
    assert calls[0][:3] == ["merge", str(target.resolve()), str(suggestion.resolve())]
    # Seam is mocked, so the output temp remains on disk; clean it up ourselves.
    Path(popens[0].output).unlink()


def test_main_wait_prints_merged_result(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    calls: list[list[str]] = []
    popens: list[_FakePopen] = []
    monkeypatch.setattr(merge_file, "launch", _stub_launch(calls, popens, MERGED))

    target, suggestion = _make_inputs(tmp_path)[:2]

    # --wait -> merge_file joins the proc, reads the OUTPUT back, main prints it verbatim.
    assert merge_file.main([str(target), str(suggestion), "--wait"]) == 0
    assert popens[0].waited is True
    assert capsys.readouterr().out == MERGED


def test_main_no_wait_prints_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    calls: list[list[str]] = []
    popens: list[_FakePopen] = []
    monkeypatch.setattr(merge_file, "launch", _stub_launch(calls, popens))

    monkeypatch.setattr(merge_file, "reap_later", lambda paths: None)

    target, suggestion = _make_inputs(tmp_path)[:2]

    # No --wait -> fire-and-forget: None outcome, nothing printed.
    assert merge_file.main([str(target), str(suggestion)]) == 0
    assert capsys.readouterr().out == ""
    # Seam is mocked, so the output temp remains on disk; clean it up ourselves.
    Path(popens[0].output).unlink()


def test_main_with_base_positional(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[list[str]] = []
    popens: list[_FakePopen] = []
    monkeypatch.setattr(merge_file, "launch", _stub_launch(calls, popens))

    target, suggestion, base = _make_inputs(tmp_path)

    # base as an optional positional threads through to the argv (base THIRD).
    assert merge_file.main([str(target), str(suggestion), str(base), "--wait"]) == 0
    argv = calls[0]
    assert argv[3] == str(base.resolve())
    assert len(argv) == 5


def test_main_missing_input_returns_1(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(merge_file, "launch", _stub_launch([], []))

    target = tmp_path / "target.py"
    target.write_text("a\n")
    missing = tmp_path / "nope.py"

    # FileNotFoundError is an OSError subclass -> rides main's except -> exit 1.
    assert merge_file.main([str(target), str(missing)]) == 1


def test_main_no_live_ide_returns_1(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # launch() is the single live-IDE guard: it raises JetBrainsError -> exit 1.
    def boom(args: list[str], *, wait: bool = False) -> object:
        raise JetBrainsError("no live IDE")

    monkeypatch.setattr(merge_file, "launch", boom)

    target, suggestion = _make_inputs(tmp_path)[:2]

    assert merge_file.main([str(target), str(suggestion)]) == 1
    assert "merge_file:" in capsys.readouterr().err


@pytest.mark.parametrize(
    "argv",
    [
        [],
        ["/x/only.py"],
        ["/x/a.py", "/x/b.py", "/x/c.py", "/x/d.py"],
    ],
)
def test_main_wrong_arg_count_exits_2(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], argv: list[str]
) -> None:
    calls: list[list[str]] = []
    popens: list[_FakePopen] = []
    monkeypatch.setattr(merge_file, "launch", _stub_launch(calls, popens))

    # 2 or 3 positionals are valid (base optional); 0, 1, and 4+ are usage errors:
    # argparse exits 2 (SystemExit) and launch is never reached.
    with pytest.raises(SystemExit) as exc:
        merge_file.main(argv)
    assert exc.value.code == 2
    assert calls == []
    assert "usage: merge_file.py" in capsys.readouterr().err
