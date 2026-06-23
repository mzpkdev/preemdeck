"""Tests for notify — hermetic: no real banners, no notify subprocess, no spawn.

notify raises an OS-wide desktop notification. The side-effecting seams are
monkeypatched so the suite is silent and identical on every OS:

- _run(cmd, env) -> bool: the wait-for-exit subprocess seam (macOS/Linux).
- _spawn(cmd, env) -> bool: the detached fire-and-forget seam (Windows balloon).
- _platform_worker(): the sys.platform dispatch, so notify()'s glue is testable
  on any host without touching sys.platform.

Layers exercised: each per-OS worker's command/env construction, the
no-injection contract (user text rides env/argv, never the script source),
notify()'s mechanism-or-None contract, the thin _run/_spawn seams against real
(silent) subprocess behavior, and the CLI (defaults, --verbose, the
no-mechanism exit-1 echo).
"""

import sys

import os_notify as notify
import pytest


def _fake_run(monkeypatch: pytest.MonkeyPatch, ok: bool, attr: str = "_run") -> list[dict[str, object]]:
    """Install a fake `_run`/`_spawn` that records (cmd, env) and returns `ok`.

    Returns the recording list so a test can assert the exact argv and env handed
    to the seam — nothing is spawned."""
    calls: list[dict[str, object]] = []

    def fake(cmd: list[str], env: dict[str, str] | None = None) -> bool:
        calls.append({"cmd": cmd, "env": env})
        return ok

    monkeypatch.setattr(notify, attr, fake)
    return calls


def _fake_which(monkeypatch: pytest.MonkeyPatch, *, found: bool) -> None:
    """Stub shutil.which so terminal-notifier presence is deterministic per test."""
    monkeypatch.setattr(notify.shutil, "which", lambda name: "/opt/bin/terminal-notifier" if found else None)


# --- _run / _spawn: the subprocess seams (real, silent commands) -------------


def test_run_false_for_missing_binary() -> None:
    assert notify._run(["preemdeck-no-such-binary-zzz"]) is False


def test_run_true_for_zero_exit() -> None:
    assert notify._run([sys.executable, "-c", "pass"]) is True


def test_run_false_for_nonzero_exit() -> None:
    assert notify._run([sys.executable, "-c", "raise SystemExit(3)"]) is False


def test_run_merges_env_into_child() -> None:
    # The notification vars must reach the child ON TOP of the inherited env.
    code = "import os, sys; sys.exit(0 if os.environ.get('PD_NOTIFY_TITLE') == 'X' else 7)"
    assert notify._run([sys.executable, "-c", code], env={"PD_NOTIFY_TITLE": "X"}) is True


def test_run_child_keeps_inherited_env() -> None:
    # env is merged over os.environ, not a replacement: PATH (inherited) survives.
    code = "import os, sys; sys.exit(0 if os.environ.get('PATH') else 7)"
    assert notify._run([sys.executable, "-c", code], env={"PD_NOTIFY_TITLE": "X"}) is True


def test_spawn_true_for_real_command() -> None:
    assert notify._spawn([sys.executable, "-c", "pass"]) is True


def test_spawn_false_for_missing_binary() -> None:
    assert notify._spawn(["preemdeck-no-such-binary-zzz"]) is False


# --- macOS worker: osascript, env-fed, static script -------------------------


def test_macos_runs_osascript_with_static_script(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_which(monkeypatch, found=False)  # terminal-notifier absent -> osascript fallback
    calls = _fake_run(monkeypatch, ok=True)
    assert notify._notify_macos("hello", "CI") == "osascript"
    cmd = calls[0]["cmd"]
    assert cmd == ["osascript", "-e", notify._MACOS_APPLESCRIPT]
    # Title/body ride the environment, never the script.
    assert calls[0]["env"] == {notify._ENV_TITLE: "CI", notify._ENV_MESSAGE: "hello"}


def test_macos_returns_none_on_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_which(monkeypatch, found=False)
    _fake_run(monkeypatch, ok=False)
    assert notify._notify_macos("hello", "CI") is None


def test_macos_prefers_terminal_notifier_when_present(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_which(monkeypatch, found=True)
    calls = _fake_run(monkeypatch, ok=True)
    assert notify._notify_macos("hello", "CI") == "terminal-notifier"
    # title/body ride argv (like notify-send), so no env is needed.
    assert calls[0]["cmd"] == ["terminal-notifier", "-title", "CI", "-message", "hello"]
    assert calls[0]["env"] is None


def test_macos_terminal_notifier_failure_falls_back_to_osascript(monkeypatch: pytest.MonkeyPatch) -> None:
    # A true failsafe: terminal-notifier is installed but errors -> osascript still fires.
    _fake_which(monkeypatch, found=True)
    calls: list[dict[str, object]] = []

    def fake(cmd: list[str], env: dict[str, str] | None = None) -> bool:
        calls.append({"cmd": cmd, "env": env})
        return cmd[0] != "terminal-notifier"  # tn fails, osascript succeeds

    monkeypatch.setattr(notify, "_run", fake)
    assert notify._notify_macos("hello", "CI") == "osascript"
    assert [c["cmd"][0] for c in calls] == ["terminal-notifier", "osascript"]


def test_macos_terminal_notifier_hostile_text_stays_argv(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_which(monkeypatch, found=True)
    calls = _fake_run(monkeypatch, ok=True)
    nasty = '"; rm -rf / #'
    notify._notify_macos(nasty, 'ti"tle')
    # The whole hostile string rides argv as discrete elements — never a script.
    assert calls[0]["cmd"] == ["terminal-notifier", "-title", 'ti"tle', "-message", nasty]
    assert calls[0]["env"] is None


# --- Linux worker: notify-send, title/body as argv ---------------------------


def test_linux_passes_title_and_body_as_argv(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _fake_run(monkeypatch, ok=True)
    assert notify._notify_linux("body text", "Heads up") == "notify-send"
    assert calls[0]["cmd"] == ["notify-send", "Heads up", "body text"]
    # notify-send takes them as argv, so no env is needed.
    assert calls[0]["env"] is None


def test_linux_returns_none_on_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_run(monkeypatch, ok=False)
    assert notify._notify_linux("body", "title") is None


# --- Windows worker: detached PowerShell balloon, env-fed --------------------


def test_windows_spawns_powershell_with_static_script(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _fake_run(monkeypatch, ok=True, attr="_spawn")
    assert notify._notify_windows("hello", "CI") == "powershell"
    assert calls[0]["cmd"] == ["powershell", "-NoProfile", "-NonInteractive", "-Command", notify._WINDOWS_POWERSHELL]
    assert calls[0]["env"] == {notify._ENV_TITLE: "CI", notify._ENV_MESSAGE: "hello"}


def test_windows_returns_none_on_spawn_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_run(monkeypatch, ok=False, attr="_spawn")
    assert notify._notify_windows("hello", "CI") is None


# --- the no-injection contract -----------------------------------------------


def test_macos_script_is_static_and_reads_env() -> None:
    # The AppleScript pulls both fields from the environment and embeds no raw
    # user-text slot — so a hostile title/body has nothing to break out of.
    assert "system attribute" in notify._MACOS_APPLESCRIPT
    assert notify._ENV_MESSAGE in notify._MACOS_APPLESCRIPT
    assert notify._ENV_TITLE in notify._MACOS_APPLESCRIPT


def test_windows_script_is_static_and_reads_env() -> None:
    assert f"$env:{notify._ENV_TITLE}" in notify._WINDOWS_POWERSHELL
    assert f"$env:{notify._ENV_MESSAGE}" in notify._WINDOWS_POWERSHELL


def test_macos_hostile_text_never_enters_the_script(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_which(monkeypatch, found=False)
    calls = _fake_run(monkeypatch, ok=True)
    nasty = '"; do shell script "rm -rf /"\n'
    notify._notify_macos(nasty, 'ti"tle')
    # The command is the unchanged static script; the hostile text is only in env.
    assert calls[0]["cmd"] == ["osascript", "-e", notify._MACOS_APPLESCRIPT]
    assert calls[0]["env"] == {notify._ENV_TITLE: 'ti"tle', notify._ENV_MESSAGE: nasty}


def test_linux_hostile_text_stays_a_single_argv_element(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _fake_run(monkeypatch, ok=True)
    nasty = "$(rm -rf /); `whoami`"
    notify._notify_linux(nasty, "title")
    # The whole hostile string is one argv element — never shell-evaluated.
    assert calls[0]["cmd"] == ["notify-send", "title", nasty]


# --- notify(): mechanism-or-None glue (platform-independent) -----------------


def test_notify_returns_worker_mechanism(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[tuple[str, str]] = []

    def worker(message: str, title: str) -> str | None:
        seen.append((message, title))
        return "osascript"

    monkeypatch.setattr(notify, "_platform_worker", lambda: worker)
    assert notify.notify("hi", "T") == "osascript"
    assert seen == [("hi", "T")]


def test_notify_returns_none_when_no_mechanism(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(notify, "_platform_worker", lambda: lambda message, title: None)
    assert notify.notify("hi") is None


def test_notify_default_title(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[tuple[str, str]] = []
    monkeypatch.setattr(notify, "_platform_worker", lambda: lambda message, title: seen.append((message, title)))
    notify.notify("hi")
    assert seen == [("hi", notify._DEFAULT_TITLE)]


# --- main() CLI: defaults, --verbose, the no-mechanism exit-1 echo -----------


def test_main_success_is_quiet_and_zero(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setattr(notify, "notify", lambda message, title=notify._DEFAULT_TITLE: "osascript")
    assert notify.main(["done"]) == 0
    assert capsys.readouterr().err == ""


def test_main_threads_title(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[tuple[str, str]] = []

    def fake(message: str, title: str = notify._DEFAULT_TITLE) -> str:
        seen.append((message, title))
        return "osascript"

    monkeypatch.setattr(notify, "notify", fake)
    assert notify.main(["shipped", "--title", "Deploy"]) == 0
    assert seen == [("shipped", "Deploy")]


@pytest.mark.parametrize("flag", ["-v", "--verbose"])
def test_main_verbose_prints_mechanism(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], flag: str
) -> None:
    monkeypatch.setattr(notify, "notify", lambda message, title=notify._DEFAULT_TITLE: "notify-send")
    assert notify.main(["hi", flag]) == 0
    assert "notify: notify-send" in capsys.readouterr().err


def test_main_no_mechanism_exits_1_and_echoes(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # No notifier available -> exit 1, and the message isn't lost (echoed to stderr).
    monkeypatch.setattr(notify, "notify", lambda message, title=notify._DEFAULT_TITLE: None)
    assert notify.main(["build failed", "--title", "CI"]) == 1
    err = capsys.readouterr().err
    assert "CI: build failed" in err


def test_main_missing_message_is_usage_error(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exc:
        notify.main([])
    assert exc.value.code == 2
    assert "usage:" in capsys.readouterr().err


def test_main_returns_int(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(notify, "notify", lambda message, title=notify._DEFAULT_TITLE: "osascript")
    assert isinstance(notify.main(["hi"]), int)
