"""Tests for notify — hermetic: no real IDE, no ideScript, no subprocess.

notify pops an in-IDE notification balloon in the running JetBrains IDE. Two
layers are exercised:

- The CLI (main): the `notify` worker it calls is monkeypatched to a recorder
  capturing the (message, title, type) it would fire — nothing spawns. The
  contract: the in_idea() gate fails fast/clean outside a JetBrains terminal
  (exit 1, worker untouched), title/type default to "PreemDeck"/"info", and
  --type is a whitelisted argparse choice.
- The Groovy render (notify.notify, end to end): the IDE-facing seams on _groovy
  are mocked exactly as test_preview does — `launch` is a recording stub that
  reads back the generated temp script (spawns nothing) and `reap_later` is a spy
  that unlinks it. That lets the tests assert the rendered Groovy: the escaped
  title/message land as well-formed literals, each --type maps to the right
  NotificationType constant, and the group id / Bus.notify call are present.
"""

from pathlib import Path

import notify
import pytest
from core import IdeaError, _groovy
from notify import notify as notify_worker


@pytest.fixture(autouse=True)
def _in_idea(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default the CLI's in_idea() gate to True so main() tests are hermetic.

    main() fails fast outside a JetBrains terminal; without this the suite would
    depend on the ambient shell. Gate-firing is covered explicitly below.
    """
    monkeypatch.setattr(notify, "in_idea", lambda: True)


# --- CLI seam: a recorder standing in for the notify worker ------------------


def _capture_notify(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, object]]:
    """Replace notify.notify (the worker the CLI calls) with a recorder.

    Returns the captured calls — nothing reaches the ideScript bridge."""
    captured: list[dict[str, object]] = []

    def fake(
        message: str,
        title: str = "PreemDeck",
        type_token: str = "info",
        actions: list[tuple[str, str | None]] | None = None,
    ) -> None:
        captured.append({"message": message, "title": title, "type": type_token, "actions": actions})

    monkeypatch.setattr(notify, "notify", fake)
    return captured


# --- main() CLI: defaults, threading, exit codes -----------------------------


def test_main_message_only_uses_defaults_and_exits_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_notify(monkeypatch)
    # A bare message: title/type fall back to "PreemDeck"/"info".
    assert notify.main(["build finished"]) == 0
    assert captured == [{"message": "build finished", "title": "PreemDeck", "type": "info", "actions": None}]


def test_main_threads_title_and_type(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_notify(monkeypatch)
    assert notify.main(["tests failed", "--title", "CI", "--type", "error"]) == 0
    assert captured == [{"message": "tests failed", "title": "CI", "type": "error", "actions": None}]


@pytest.mark.parametrize("kind", ["info", "warning", "error"])
def test_main_accepts_each_type_choice(monkeypatch: pytest.MonkeyPatch, kind: str) -> None:
    captured = _capture_notify(monkeypatch)
    assert notify.main(["msg", "--type", kind]) == 0
    assert captured == [{"message": "msg", "title": "PreemDeck", "type": kind, "actions": None}]


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


# --- main() CLI: --action parsing, whitelist, arg-presence -------------------


def test_main_threads_single_action(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_notify(monkeypatch)
    # --action name=arg parses to a (name, arg) pair handed to the worker.
    assert notify.main(["msg", "--action", "open-url=https://example.com"]) == 0
    assert captured == [
        {"message": "msg", "title": "PreemDeck", "type": "info", "actions": [("open-url", "https://example.com")]}
    ]


def test_main_threads_multiple_actions_in_cli_order(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_notify(monkeypatch)
    # Repeatable: each --action appends, preserving the order given on the CLI.
    code = notify.main(["msg", "--action", "open-preview=https://x", "--action", "open-file=/tmp"])
    assert code == 0
    assert captured[0]["actions"] == [("open-preview", "https://x"), ("open-file", "/tmp")]


def test_main_action_arg_splits_on_first_equals_only(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _capture_notify(monkeypatch)
    # A URL arg carries its own '=' (query string): split on the FIRST '=' only,
    # so the whole URL lands in the arg untouched.
    url = "open-url=https://example.com/search?a=1&b=2"
    assert notify.main(["msg", "--action", url]) == 0
    assert captured[0]["actions"] == [("open-url", "https://example.com/search?a=1&b=2")]


def test_main_rejects_unknown_action_as_usage_error(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # --action name is whitelisted: an unknown name is a usage error (exit 2) and
    # the worker is never reached.
    captured = _capture_notify(monkeypatch)
    with pytest.raises(SystemExit) as exc:
        notify.main(["msg", "--action", "open-everything=x"])
    assert exc.value.code == 2
    assert captured == []
    assert "usage:" in capsys.readouterr().err


def test_main_rejects_action_missing_required_arg(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # A known action with no arg (every registry action needs one) is a usage
    # error (exit 2); the worker is never reached.
    captured = _capture_notify(monkeypatch)
    with pytest.raises(SystemExit) as exc:
        notify.main(["msg", "--action", "open-url"])
    assert exc.value.code == 2
    assert captured == []
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


def test_main_gate_fires_even_with_actions(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    # The in_idea() gate still fires (exit 1, worker untouched) outside a
    # JetBrains terminal even when valid --action flags are present — the gate is
    # upstream of any action work.
    monkeypatch.setattr(notify, "in_idea", lambda: False)
    captured = _capture_notify(monkeypatch)
    assert notify.main(["msg", "--action", "open-url=https://example.com"]) == 1
    assert captured == []
    assert "notify: no JetBrains IDE in the process ancestry" in capsys.readouterr().err


def test_main_no_live_ide_returns_1(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    # The worker raising IdeaError (deeper resolver guard) surfaces as exit 1.
    def boom(
        message: str,
        title: str = "PreemDeck",
        type_token: str = "info",
        actions: list[tuple[str, str | None]] | None = None,
    ) -> None:
        raise IdeaError("no JetBrains IDE in the process ancestry")

    monkeypatch.setattr(notify, "notify", boom)
    assert notify.main(["build finished"]) == 1
    assert "notify:" in capsys.readouterr().err


def test_main_non_macos_stub_returns_1(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    # A non-macOS stub platform raises NotImplementedError -> exit 1, same handler.
    def boom(
        message: str,
        title: str = "PreemDeck",
        type_token: str = "info",
        actions: list[tuple[str, str | None]] | None = None,
    ) -> None:
        raise NotImplementedError("resolve_exec_path is not implemented for Linux yet")

    monkeypatch.setattr(notify, "notify", boom)
    assert notify.main(["build finished"]) == 1
    assert "notify:" in capsys.readouterr().err


def test_main_returns_int_not_none(monkeypatch: pytest.MonkeyPatch) -> None:
    # main() must return an int exit code (consumed by SystemExit), never None.
    _capture_notify(monkeypatch)
    result = notify.main(["build finished"])
    assert isinstance(result, int)


# --- the rendered Groovy (notify.notify end to end, IDE seams mocked) --------


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
    """Wire the launch spy + a reap_later spy onto _groovy (shared bridge).

    notify() rides _groovy's run_groovy, so the seams live on _groovy. The reap
    spy unlinks immediately (what the real reaper does, minus the delay) so the
    test leaves no temp behind."""
    monkeypatch.setattr(_groovy, "launch", spy)

    def reap(paths: list[str]) -> None:
        for path in list(paths):
            Path(path).unlink(missing_ok=True)

    monkeypatch.setattr(_groovy, "reap_later", reap)


def test_notify_runs_idescript_blocking(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    notify_worker("hello")

    # Shares preview_url's scaffolding: exactly one blocking ideScript run.
    assert len(spy.calls) == 1
    call = spy.calls[0]
    assert call["wait"] is True
    assert call["args"][0] == "ideScript"
    assert call["args"][1].endswith(".groovy")


def test_notify_injects_message_title_and_bus_notify(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    notify_worker("build finished", title="CI")

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

    notify_worker("hello")

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

    notify_worker("msg", type_token=kind)

    groovy = spy.scripts[0]
    # Each whitelisted --type maps to its NotificationType constant, embedded as a
    # bare token (never raw user input).
    assert f"NotificationType.{constant}" in groovy


def test_notify_default_type_is_information(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    notify_worker("msg")

    groovy = spy.scripts[0]
    # Default type "info" -> NotificationType.INFORMATION.
    assert "NotificationType.INFORMATION" in groovy


def test_notify_escapes_quotes_and_backslashes_in_message(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    # A message with a quote and a backslash must land as an escaped Groovy
    # literal, not break out of the string (which would be a malformed script).
    notify_worker('he said "hi"\\done', title='ti"tle\\x')

    groovy = spy.scripts[0]
    assert 'he said \\"hi\\"\\\\done' in groovy
    assert 'ti\\"tle\\\\x' in groovy
    # The unescaped form must NOT appear (no literal break).
    assert '"he said "hi"\\done"' not in groovy


# --- the rendered action buttons (notify.notify end to end, IDE seams mocked) -


def test_notify_no_actions_renders_no_addaction(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    # Backward compat: no --action -> the actions block is empty, so the rendered
    # Groovy carries no addAction line and the body is the action-less shape.
    notify_worker("hello")

    groovy = spy.scripts[0]
    assert "addAction" not in groovy
    # The Bus.notify follows the Notification directly — no blank gap from an
    # empty actions slot (render unchanged from before the feature).
    assert "NotificationType.INFORMATION)\n    Notifications.Bus.notify(n, project)" in groovy


def test_notify_open_url_renders_browse_closure(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    notify_worker("msg", actions=[("open-url", "https://example.com")])

    groovy = spy.scripts[0]
    # The button label is the static registry string; the closure browses the URL
    # in the external browser; `as Runnable` disambiguates the overload.
    assert 'NotificationAction.createSimple("Open in browser"' in groovy
    assert 'com.intellij.ide.BrowserUtil.browse("https://example.com")' in groovy
    assert "as Runnable))" in groovy


def test_notify_open_file_renders_editor_open_closure(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    notify_worker("msg", actions=[("open-file", "/tmp/build.log")])

    groovy = spy.scripts[0]
    # The label + a closure that re-fetches the project, resolves the path via
    # LocalFileSystem (null-guarded), and opens it in the editor.
    assert 'NotificationAction.createSimple("Open file"' in groovy
    assert 'LocalFileSystem.getInstance().findFileByPath("/tmp/build.log")' in groovy
    assert "if (vf == null) return" in groovy
    # Opens against the closure's re-fetched project (under the non-colliding
    # `actionProject` name, so it doesn't shadow the enclosing scope).
    assert "FileEditorManager.getInstance(actionProject).openFile(vf, true)" in groovy
    # The project is re-fetched INSIDE the closure (it runs long after build time).
    assert "ProjectManager.getInstance().getOpenProjects()" in groovy.split("createSimple")[1]


def test_notify_open_preview_reuses_shared_webpreview_mechanism(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    notify_worker("msg", actions=[("open-preview", "http://localhost:3000")])

    groovy = spy.scripts[0]
    # open-preview MUST behave exactly like preview_url: the SAME WebPreview
    # mechanism (the shared `webpreview_open_body` fragment) — registry-gated,
    # Urls.newFromEncoded, LightVirtualFile, WebPreviewVirtualFile, openFile —
    # proving parity with preview_url rather than a divergent hand-written copy.
    assert 'NotificationAction.createSimple("Open preview"' in groovy
    assert 'com.intellij.util.Urls.newFromEncoded("http://localhost:3000")' in groovy
    assert "com.intellij.testFramework.LightVirtualFile" in groovy
    assert "com.intellij.ide.browsers.actions.WebPreviewVirtualFile" in groovy
    assert "openFile(previewFile, true)" in groovy
    # The same registry gate preview_url uses.
    assert 'Registry.is("ide.web.preview.enabled")' in groovy
    assert 'Registry.is("ide.browser.jcef.enabled")' in groovy


def test_notify_open_preview_renders_same_fragment_as_preview_url(monkeypatch: pytest.MonkeyPatch) -> None:
    # Parity, asserted directly: the open-preview closure must embed the EXACT
    # shared fragment that core's preview path renders for the same URL — proof
    # they can't drift (one source of truth: webpreview_open_body).
    from core import webpreview_open_body
    from core._groovy import escape_groovy

    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    url = "http://localhost:3000"
    notify_worker("msg", actions=[("open-preview", url)])

    groovy = spy.scripts[0]
    # The closure indents each body line to 8 spaces (inside invokeLater + the
    # closure braces) and re-fetches the project under `actionProject` (so it does
    # not shadow the enclosing scope's `project`); render the shared fragment the
    # same way and assert it lands verbatim — same source of truth as preview_url,
    # only re-indented and re-pointed at the closure's project local.
    fragment = webpreview_open_body(escape_groovy(url), escape_groovy(url), project_var="actionProject", indent=" " * 8)
    assert fragment in groovy


def test_notify_multiple_actions_render_in_cli_order(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    notify_worker("msg", actions=[("open-preview", "https://x"), ("open-file", "/tmp")])

    groovy = spy.scripts[0]
    # Two buttons -> two addAction lines, in the order the actions were given.
    assert groovy.count("addAction") == 2
    assert groovy.index('createSimple("Open preview"') < groovy.index('createSimple("Open file"')


def test_notify_action_arg_is_escaped(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    # An arg with a quote and a backslash must land as an escaped Groovy literal
    # in the closure body, not break out of the string (a malformed script).
    notify_worker("msg", actions=[("open-url", 'https://x/?q="a\\b"')])

    groovy = spy.scripts[0]
    assert 'browse("https://x/?q=\\"a\\\\b\\"")' in groovy
    # The unescaped form must NOT appear (no literal break).
    assert 'browse("https://x/?q="a\\b"")' not in groovy


@pytest.mark.parametrize("action", ["open-file", "open-preview"])
def test_notify_project_refetch_does_not_shadow_enclosing_scope(monkeypatch: pytest.MonkeyPatch, action: str) -> None:
    spy = _LaunchSpy()
    _install(monkeypatch, spy)

    # Regression: the enclosing invokeLater block declares `def projects`/`def
    # project`; a closure that re-declared those names is a Groovy compile error
    # ("scope already contains a variable") that only surfaces at IDE eval, not in
    # Python. The closures must re-fetch under non-colliding `action*` names — so
    # no `def project`/`def projects` may appear at the closure's 8-space indent.
    notify_worker("msg", actions=[(action, "x")])

    groovy = spy.scripts[0]
    assert "        def project " not in groovy
    assert "        def projects " not in groovy
    # The re-fetch is still present, just under the non-colliding name.
    assert "        def actionProject " in groovy
