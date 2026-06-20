"""Tests for diff_inline — hermetic: no real IDE, no real diff_file, no spawn.

diff_inline.diff_file is monkeypatched with a stub that records the two paths
it's handed plus the wait flag, AND snapshots each temp's contents at call time
(before diff_inline's cleanup can run). The stub returns "RECONCILED\n" when
wait=True and None when wait=False, mirroring diff_file's real contract. That
lets the tests assert: both temps carry the right strings, the suffix is
honored, and cleanup is gated on wait (temps gone after wait=True, still present
after wait=False).
"""

import os
from pathlib import Path

import diff_inline
import pytest
from diff_inline import diff_inline as diff_fn

RECONCILED = "RECONCILED\n"


class _Spy:
    """A diff_file() stub: records (target, suggestion, wait) and snapshots each
    temp's contents at call time (before diff_inline cleans them up)."""

    def __init__(self, result: str | None = RECONCILED) -> None:
        self.result = result
        self.target: str | None = None
        self.suggestion: str | None = None
        self.wait: bool | None = None
        self.contents: dict[str, str] = {}

    def __call__(self, target: str, suggestion: str, *, wait: bool = False) -> str | None:
        self.target, self.suggestion, self.wait = target, suggestion, wait
        for path in (target, suggestion):
            self.contents[path] = Path(path).read_text()
        return self.result

    @property
    def paths(self) -> list[str]:
        return [self.target, self.suggestion]


# --- spill + return ---------------------------------------------------------


def test_spills_a_and_b_returns_reconciled(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _Spy()
    monkeypatch.setattr(diff_inline, "diff_file", spy)

    assert diff_fn("alpha", "beta", wait=True) == RECONCILED
    # exactly two temps, contents round-trip the input strings in positional order.
    assert len(spy.paths) == 2
    assert spy.contents[spy.target] == "alpha"
    assert spy.contents[spy.suggestion] == "beta"
    # wait=True -> both temps unlinked afterward.
    for path in spy.paths:
        assert not os.path.exists(path)


def test_passes_wait_flag_through(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _Spy()
    monkeypatch.setattr(diff_inline, "diff_file", spy)

    diff_fn("alpha", "beta", wait=True)
    assert spy.wait is True


# --- wait=False: launch only, no cleanup ------------------------------------


def test_no_wait_returns_none_and_schedules_reap(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _Spy(result=None)
    monkeypatch.setattr(diff_inline, "diff_file", spy)
    # Spy on the reap seam so nothing is actually deleted (no real thread/sleep);
    # we only assert both temps were *scheduled* for deferred cleanup.
    reaped: list[list[str]] = []
    monkeypatch.setattr(diff_inline, "reap_later", lambda paths: reaped.append(list(paths)))

    # Default (wait=False): diff_file is handed wait=False, returns None.
    assert diff_fn("alpha", "beta") is None
    assert spy.wait is False
    assert len(spy.paths) == 2
    # The IDE was launched async -> both temps are handed to reap_later (one call,
    # both paths in positional order) instead of being leaked.
    assert reaped == [spy.paths]
    # The seam is mocked, so the temps are still on disk; clean them up ourselves.
    for path in spy.paths:
        assert os.path.exists(path)
        os.unlink(path)


# --- suffix override --------------------------------------------------------


def test_suffix_override_applied_to_every_temp(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _Spy()
    monkeypatch.setattr(diff_inline, "diff_file", spy)

    diff_fn("alpha", "beta", suffix=".py", wait=True)
    # one suffix governs both temps (same kind of content).
    assert len(spy.paths) == 2
    for path in spy.paths:
        assert path.endswith(".py")


def test_default_suffix_is_txt(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _Spy()
    monkeypatch.setattr(diff_inline, "diff_file", spy)

    diff_fn("alpha", "beta", wait=True)
    for path in spy.paths:
        assert path.endswith(".txt")


# --- CLI --------------------------------------------------------------------


def test_main_wait_prints_reconciled_contents(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    spy = _Spy(result=RECONCILED)
    monkeypatch.setattr(diff_inline, "diff_file", spy)

    # --wait -> diff_inline returns the reconciled text, main prints it verbatim.
    assert diff_inline.main(["alpha", "beta", "--wait"]) == 0
    assert spy.wait is True
    assert capsys.readouterr().out == RECONCILED


def test_main_no_wait_prints_nothing(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    spy = _Spy(result=None)
    monkeypatch.setattr(diff_inline, "diff_file", spy)
    # Mock the reap seam (no real thread/sleep); the temps are scheduled, not leaked.
    reaped: list[list[str]] = []
    monkeypatch.setattr(diff_inline, "reap_later", lambda paths: reaped.append(list(paths)))

    # No --wait -> fire-and-forget: None outcome, nothing printed.
    assert diff_inline.main(["alpha", "beta"]) == 0
    assert spy.wait is False
    assert capsys.readouterr().out == ""
    assert reaped == [spy.paths]
    # Seam is mocked, so the temps remain on disk; clean them up ourselves.
    for path in spy.paths:
        os.unlink(path)


def test_main_suffix_flag_threads_into_diff_inline(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    spy = _Spy(result=RECONCILED)
    monkeypatch.setattr(diff_inline, "diff_file", spy)

    assert diff_inline.main(["alpha", "beta", "--suffix", ".md", "--wait"]) == 0
    for path in spy.paths:
        assert path.endswith(".md")


def test_main_no_live_ide_returns_1(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    from core import JetBrainsError

    def boom(target: str, suggestion: str, *, wait: bool = False) -> str | None:
        raise JetBrainsError("no live IDE")

    monkeypatch.setattr(diff_inline, "diff_file", boom)

    # JetBrainsError propagates from diff_file -> exit 1, message on stderr.
    assert diff_inline.main(["alpha", "beta"]) == 1
    assert "diff_inline:" in capsys.readouterr().err


@pytest.mark.parametrize(
    "argv",
    [
        [],
        ["only"],
        ["a", "b", "c"],
    ],
)
def test_main_wrong_arg_count_exits_2(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], argv: list[str]
) -> None:
    spy = _Spy()
    monkeypatch.setattr(diff_inline, "diff_file", spy)

    # Exactly 2 positionals are valid; 0, 1, and 3+ are usage errors: argparse exits 2.
    with pytest.raises(SystemExit) as exc:
        diff_inline.main(argv)
    assert exc.value.code == 2
    assert spy.wait is None
    assert "usage: diff_inline.py" in capsys.readouterr().err
