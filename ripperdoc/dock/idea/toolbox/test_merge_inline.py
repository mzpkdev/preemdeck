"""Tests for merge_inline — hermetic: no real IDE, no real merge_file, no spawn.

merge_inline.merge_file is monkeypatched with a spy that records the paths it's
handed (target, suggestion, base) plus the wait flag, AND snapshots each input
temp's contents at call time (before merge_inline's cleanup can run). The spy
returns "MERGED\n" when wait=True and None when wait=False, mirroring
merge_file's real contract. That lets the tests assert: the input temps carry
the right strings, base is omitted (None) when not given, the suffix is honored,
and cleanup is gated on wait (temps gone after wait=True, still present after
wait=False).
"""

import os
from pathlib import Path

import merge_inline
import pytest
from merge_inline import merge_inline as merge_fn

MERGED = "MERGED\n"


@pytest.fixture(autouse=True)
def _in_idea(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default the CLI's in_idea() gate to True so main() tests are hermetic.

    main() now fails fast outside a JetBrains terminal; without this the suite
    would depend on the ambient shell.
    """
    monkeypatch.setattr(merge_inline, "in_idea", lambda: True)


class _Spy:
    """A merge_file() stub: records (target, suggestion, base, wait) and snapshots
    each input temp's contents at call time (before merge_inline cleans them up)."""

    def __init__(self, result: str | None = MERGED) -> None:
        self.result = result
        self.target: str | None = None
        self.suggestion: str | None = None
        self.base: str | None = None
        self.wait: bool | None = None
        self.contents: dict[str, str] = {}

    def __call__(self, target: str, suggestion: str, base: str | None = None, *, wait: bool = False) -> str | None:
        self.target, self.suggestion, self.base, self.wait = target, suggestion, base, wait
        inputs = [target, suggestion] + ([base] if base is not None else [])
        for path in inputs:
            self.contents[path] = Path(path).read_text()
        return self.result

    @property
    def paths(self) -> list[str]:
        """The input temps merge_inline created (base only if it was passed)."""
        return [self.target, self.suggestion] + ([self.base] if self.base is not None else [])


# --- spill + return ---------------------------------------------------------


def test_spills_target_suggestion_returns_merged(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _Spy()
    monkeypatch.setattr(merge_inline, "merge_file", spy)

    assert merge_fn("alpha", "beta", wait=True) == MERGED
    # no base -> exactly two input temps, contents round-trip the input strings.
    assert len(spy.paths) == 2
    assert spy.base is None
    assert spy.contents[spy.target] == "alpha"
    assert spy.contents[spy.suggestion] == "beta"
    # wait=True -> input temps unlinked afterward.
    for path in spy.paths:
        assert not os.path.exists(path)


def test_spills_base_when_given(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _Spy()
    monkeypatch.setattr(merge_inline, "merge_file", spy)

    assert merge_fn("alpha", "beta", "origin", wait=True) == MERGED
    # base given -> three input temps, base contents round-trip too.
    assert len(spy.paths) == 3
    assert spy.base is not None
    assert spy.contents[spy.base] == "origin"
    for path in spy.paths:
        assert not os.path.exists(path)


def test_base_omitted_passes_none(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _Spy()
    monkeypatch.setattr(merge_inline, "merge_file", spy)

    merge_fn("alpha", "beta", wait=True)
    # No base argument -> merge_file is handed base=None (no third temp minted).
    assert spy.base is None


def test_passes_wait_flag_through(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _Spy()
    monkeypatch.setattr(merge_inline, "merge_file", spy)

    merge_fn("alpha", "beta", wait=True)
    assert spy.wait is True


# --- wait=False: launch only, no cleanup ------------------------------------


def test_no_wait_returns_none_and_schedules_reap(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _Spy(result=None)
    monkeypatch.setattr(merge_inline, "merge_file", spy)
    # Spy on the reap seam so nothing is actually deleted (no real thread/sleep);
    # we only assert the INPUT temps were *scheduled* for deferred cleanup.
    reaped: list[list[str]] = []
    monkeypatch.setattr(merge_inline, "reap_later", lambda paths: reaped.append(list(paths)))

    # Default (wait=False): merge_file is handed wait=False, returns None.
    assert merge_fn("alpha", "beta", "origin") is None
    assert spy.wait is False
    assert len(spy.paths) == 3
    # The IDE was launched async -> the three INPUT temps are handed to reap_later
    # (one call) instead of being leaked. The output temp is merge_file's to reap.
    assert reaped == [spy.paths]
    # The seam is mocked, so the temps are still on disk; clean them up ourselves.
    for path in spy.paths:
        assert os.path.exists(path)
        os.unlink(path)


# --- suffix override --------------------------------------------------------


def test_suffix_override_applied_to_every_temp(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _Spy()
    monkeypatch.setattr(merge_inline, "merge_file", spy)

    merge_fn("alpha", "beta", "origin", suffix=".py", wait=True)
    # one suffix governs every temp (same kind of content).
    assert len(spy.paths) == 3
    for path in spy.paths:
        assert path.endswith(".py")


def test_default_suffix_is_txt(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _Spy()
    monkeypatch.setattr(merge_inline, "merge_file", spy)

    merge_fn("alpha", "beta", wait=True)
    for path in spy.paths:
        assert path.endswith(".txt")


# --- CLI --------------------------------------------------------------------


def test_main_wait_prints_merged_contents(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    spy = _Spy(result=MERGED)
    monkeypatch.setattr(merge_inline, "merge_file", spy)

    # --wait -> merge_inline returns the merged text, main prints it verbatim.
    assert merge_inline.main(["alpha", "beta", "--wait"]) == 0
    assert spy.wait is True
    assert capsys.readouterr().out == MERGED


def test_main_no_wait_prints_nothing(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    spy = _Spy(result=None)
    monkeypatch.setattr(merge_inline, "merge_file", spy)
    # Mock the reap seam (no real thread/sleep); the input temps are scheduled, not leaked.
    reaped: list[list[str]] = []
    monkeypatch.setattr(merge_inline, "reap_later", lambda paths: reaped.append(list(paths)))

    # No --wait -> fire-and-forget: None outcome, nothing printed.
    assert merge_inline.main(["alpha", "beta"]) == 0
    assert spy.wait is False
    assert capsys.readouterr().out == ""
    assert reaped == [spy.paths]
    # Seam is mocked, so the temps remain on disk; clean them up ourselves.
    for path in spy.paths:
        os.unlink(path)


def test_main_base_positional_threads_through(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _Spy(result=MERGED)
    monkeypatch.setattr(merge_inline, "merge_file", spy)

    # base as an optional positional -> a third temp is minted and its contents land.
    assert merge_inline.main(["alpha", "beta", "origin", "--wait"]) == 0
    assert spy.base is not None
    assert spy.contents[spy.base] == "origin"


def test_main_suffix_flag_threads_into_merge_inline(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    spy = _Spy(result=MERGED)
    monkeypatch.setattr(merge_inline, "merge_file", spy)

    assert merge_inline.main(["alpha", "beta", "--suffix", ".md", "--wait"]) == 0
    for path in spy.paths:
        assert path.endswith(".md")


def test_main_no_live_ide_returns_1(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    from core import IdeaError

    def boom(target: str, suggestion: str, base: str | None = None, *, wait: bool = False) -> str | None:
        raise IdeaError("no live IDE")

    monkeypatch.setattr(merge_inline, "merge_file", boom)

    # IdeaError propagates from merge_file -> exit 1, message on stderr.
    assert merge_inline.main(["alpha", "beta"]) == 1
    assert "merge_inline:" in capsys.readouterr().err


@pytest.mark.parametrize(
    "argv",
    [
        [],
        ["only"],
        ["a", "b", "c", "d"],
    ],
)
def test_main_wrong_arg_count_exits_2(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], argv: list[str]
) -> None:
    spy = _Spy()
    monkeypatch.setattr(merge_inline, "merge_file", spy)

    # 2 or 3 positionals are valid (base optional); 0, 1, and 4+ are usage errors:
    # argparse exits 2.
    with pytest.raises(SystemExit) as exc:
        merge_inline.main(argv)
    assert exc.value.code == 2
    assert spy.wait is None
    assert "usage: merge_inline.py" in capsys.readouterr().err
