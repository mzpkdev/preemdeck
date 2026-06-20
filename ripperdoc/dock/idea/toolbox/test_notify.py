"""Tests for notify — hermetic: no real IDE, no ideScript, no subprocess.

notify pops an in-IDE notification balloon in the running JetBrains IDE. Two
layers are exercised:

- The CLI (main): the `notify` worker it imports is monkeypatched to a recorder
  capturing the (message, title, type) it would fire — nothing spawns. The
  contract: the in_idea() gate fails fast/clean outside a JetBrains terminal
  (exit 1, worker untouched), title/type default to "PreemDeck"/"info", and
  --type is a whitelisted argparse choice.
- The Groovy render (core.notify, end to end): the IDE-facing seams on _preview
  are mocked exactly as test_preview does — `launch` is a recording stub that
  reads back the generated temp script (spawns nothing) and `reap_later` is a spy
  that unlinks it. That lets the tests assert the rendered Groovy: the escaped
  title/message land as well-formed literals, each --type maps to the right
  NotificationType constant, and the group id / Bus.notify call are present.
"""

from pathlib import Path

import notify
import pytest
from core import IdeaError, _preview
from notify import notify_message


@pytest.fixture(autouse=True)
def _in_idea(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default the CLI's in_idea() gate to True so main() tests are hermetic.

    main() fails fast outside a JetBrains terminal; without this the suite would
    depend on the ambient shell. Gate-firing is covered explicitly below.
    """
    monkeypatch.setattr(notify, "in_idea", lambda: True)


# --- CLI seam: a recorder standing in for the core.notify worker -------------


def _capture_notify(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, object]]:
    """Replace notify.notify (the worker the CLI calls) with a recorder.

    Returns the captured calls — nothing reaches the ideScript bridge."""
    captured: list[dict[str, object]] = []

    def fake(message: str, title: str = "PreemDeck", type_token: str = "info") -> None:
        captured.append({"message": message, "title": title, "type": type_token})

    monkeypatch.setattr(notify, "notify", fake)
    return captured


# --- main() CLI: defaults, threading, exit codes -----------------------------


def test_main_message_only_uses_defaults_and_exits_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_notify(monkeypatch)
    # A bare message: title/type fall back to "PreemDeck"/"info".
    assert notify.main(["build finished"]) == 0
    assert captured == [{"message": "build finished", "title": "PreemDeck", "type": "info"}]


def test_main_threads_title_and_type(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_notify(monkeypatch)
    assert notify.main(["tests failed", "--title", "CI", "--type", "error"]) == 0
    assert captured == [{"message": "tests failed", "title": "CI", "type": "error"}]


@pytest.mark.parametrize("kind", ["info", "warning", "error"])
def test_main_accepts_each_type_choice(monkeypatch: pytest.MonkeyPatch, kind: str) -> None:
    captured = _capture_notify(monkeypatch)
    assert notify.main(["msg", "--type", kind]) == 0
    assert captured == [{"message": "msg", "title": "PreemDeck", "type": kind}]


def test_main_rejects_unknown_type_as_usage_error(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # --type is a whitelisted argparse choice: anything else is a usage error
    # (exit 2) and the worker is never reached.
    captured = _capture_notify(monkeypatch)
    with pytest.raises(SystemExit) as exc:
        notify.main(["msg", "--type", "fatal"])
    assert exc.value.code == 2
    assert captured == []
    assert "usage:" in capsys.readouterr().err


def test_main_missing_message_is_usage_error(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # No positional -> argparse exits 2 (SystemExit) and the worker is never called.
    _capture_notify(monkeypatch)
    with pytest.raises(SystemExit) as exc:
        notify.main([])
    assert exc.value.code == 2
    assert "usage:" in capsys.readouterr().err


def test_main_outside_jetbrains_returns_1_before_work(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # Cheap CLI gate: outside a JetBrains terminal in_idea() is False, so main()
    # exits 1 with the canonical resolver message and never reaches the worker.
    monkeypatch.setattr(notify, "in_idea", lambda: False)
    captured = _capture_notify(monkeypatch)
    assert notify.main(["build finished"]) == 1
    assert captured == []
    assert "notify: no JetBrains IDE in the process ancestry" in capsys.readouterr().err


def test_main_no_live_ide_returns_1(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    # The worker raising IdeaError (deeper resolver guard) surfaces as exit 1.
    def boom(message: str, title: str = "PreemDeck", type_token: str = "info") -> None:
        raise IdeaError("no JetBrains IDE in the process ancestry")

    monkeypatch.setattr(notify, "notify", boom)
    assert notify.main(["build finished"]) == 1
    assert "notify:" in capsys.readouterr().err


def test_main_non_macos_stub_returns_1(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    # A non-macOS stub platform raises NotImplementedError -> exit 1, same handler.
    def boom(message: str, title: str = "PreemDeck", type_token: str = "info") -> None:
        raise NotImplementedError("resolve_exec_path is not implemented for Linux yet")

    monkeypatch.setattr(notify, "notify", boom)
    assert notify.main(["build finished"]) == 1
    assert "notify:" in capsys.readouterr().err


def test_main_returns_int_not_none(monkeypatch: pytest.MonkeyPatch) -> None:
    # main() must return an int exit code (consumed by SystemExit), never None.
    _capture_notify(monkeypatch)
    result = notify.main(["build finished"])
    assert isinstance(result, int)


# --- the rendered Groovy (core.notify end to end, IDE seams mocked) ----------


class _LaunchSpy:
    """A launch() stub: records argv + wait, reads the temp script back, spawns
    nothing. The script is read at call time, before notify's reap runs."""

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []
        self.scripts: list[str] = []

    def __call__(self, args: list[str], *, wait: bool = False) -> object:
        self.calls.append({"args": args, "wait": wait})
        # args is ["ideScript", <script path>]: capture the generated Groovy now.
        self.scripts.append(Path(args[-1]).read_text())
        return object()


def _install(monkeypatch: pytest.MonkeyPatch, spy: _LaunchSpy) -> None:
    """Wire the launch spy + a reap_later spy onto _preview (shared bridge).

    notify() rides _preview's _run_groovy, so the seams live on _preview. The reap
    spy unlinks immediately (what the real reaper does, minus the delay) so the
    test leaves no temp behind."""
    monkeypatch.setattr(_preview, "launch", spy)

    def reap(paths: list[str]) -> None:
        for path in list(paths):
            Path(path).unlink(missing_ok=True)

    monkeypatch.setattr(_preview, "reap_later", reap)


def test_notify_runs_idescript_blocking(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    notify_message("hello")

    # Shares preview_url's scaffolding: exactly one blocking ideScript run.
    assert len(spy.calls) == 1
    call = spy.calls[0]
    assert call["wait"] is True
    assert call["args"][0] == "ideScript"
    assert call["args"][1].endswith(".groovy")


def test_notify_injects_message_title_and_bus_notify(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    notify_message("build finished", title="CI")

    groovy = spy.scripts[0]
    # The notification is constructed and handed to the Bus, scoped to the first
    # open project (or null when none is open).
    assert "new Notification(" in groovy
    assert "Notifications.Bus.notify(n, project)" in groovy
    assert "getOpenProjects()" in groovy
    # Title and message land as the literals the script passes to Notification.
    assert '"CI"' in groovy
    assert '"build finished"' in groovy
    # Registered under the toolbox group id.
    assert '"idea.toolbox"' in groovy


def test_notify_default_title_is_preemdeck(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    notify_message("hello")

    groovy = spy.scripts[0]
    # Default title flows through to the rendered literal.
    assert '"PreemDeck"' in groovy


@pytest.mark.parametrize(
    ("kind", "constant"),
    [("info", "INFORMATION"), ("warning", "WARNING"), ("error", "ERROR")],
)
def test_notify_type_maps_to_notification_constant(monkeypatch: pytest.MonkeyPatch, kind: str, constant: str) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    notify_message("msg", type_token=kind)

    groovy = spy.scripts[0]
    # Each whitelisted --type maps to its NotificationType constant, embedded as a
    # bare token (never raw user input).
    assert f"NotificationType.{constant}" in groovy


def test_notify_default_type_is_information(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    notify_message("msg")

    groovy = spy.scripts[0]
    # Default type "info" -> NotificationType.INFORMATION.
    assert "NotificationType.INFORMATION" in groovy


def test_notify_escapes_quotes_and_backslashes_in_message(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    # A message with a quote and a backslash must land as an escaped Groovy
    # literal, not break out of the string (which would be a malformed script).
    notify_message('he said "hi"\\done', title='ti"tle\\x')

    groovy = spy.scripts[0]
    assert 'he said \\"hi\\"\\\\done' in groovy
    assert 'ti\\"tle\\\\x' in groovy
    # The unescaped form must NOT appear (no literal break).
    assert '"he said "hi"\\done"' not in groovy
