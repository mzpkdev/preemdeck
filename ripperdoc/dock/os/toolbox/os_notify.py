#!/usr/bin/env python3
"""Raise an OS-wide desktop notification — cross-platform (macOS, Linux, Windows).

Sibling to `ding` (which makes a sound): `notify` pops a banner/toast in the OS's
notification center. No third-party deps — each platform drives a built-in:

- macOS:   osascript `display notification` -> a Notification Center banner.
- Linux:   `notify-send` (libnotify) — the freedesktop standard, present on most
           GNOME/KDE desktops.
- Windows: PowerShell + a System.Windows.Forms NotifyIcon balloon (.NET ships
           with Windows; no module to install).

User text is NEVER spliced into a script: macOS and Windows read the title/body
from environment variables (AppleScript `system attribute` / PowerShell `$env:`),
Linux passes them as argv to notify-send. So a title or body containing quotes,
backslashes, or newlines can't break out into code — there is no script string
for it to break out of.

Best-effort: a missing mechanism (no notify-send, an exotic platform) returns
None rather than raising. Unlike `ding`, there is NO universal floor — a desktop
with no notifier simply can't show a banner — so `notify()` returns the mechanism
that fired or None, and the CLI surfaces None as exit 1 (echoing the text to
stderr so it isn't lost).

The Windows balloon is fire-and-forget: its owning process must outlive the call
(a NotifyIcon vanishes when its process dies), so the PowerShell script shows the
balloon, sleeps briefly, then disposes — spawned detached so `notify()` returns
at once. "Success" there means "launched", not "displayed".
"""

import argparse
import os
import subprocess
import sys
from collections.abc import Callable

_DEFAULT_TITLE = "PreemDeck"

# User text is handed to the platform mechanism out-of-band — via these env vars
# on macOS/Windows, via argv on Linux — never interpolated into a script, so
# quotes/backslashes/newlines in the title or body can't break out into code.
_ENV_TITLE = "PD_NOTIFY_TITLE"
_ENV_MESSAGE = "PD_NOTIFY_MESSAGE"

# macOS: a static AppleScript that reads the title/body from the environment
# (`system attribute` returns an env var's value), so no user text is ever
# embedded in the script source. Only our own constant env-var NAMES are spliced.
_MACOS_APPLESCRIPT = (
    f'display notification (system attribute "{_ENV_MESSAGE}") with title (system attribute "{_ENV_TITLE}")'
)

# Windows: a static PowerShell one-liner that reads the title/body from $env: and
# raises a tray balloon via .NET WinForms (no extra module). It must outlive the
# Python call — a NotifyIcon disappears when its process exits — so it shows the
# balloon, sleeps, then disposes; we spawn it detached and don't wait. Only our
# own constant env-var names are spliced; the user text stays in the environment.
_WINDOWS_POWERSHELL = (
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; "
    "$n = New-Object System.Windows.Forms.NotifyIcon; "
    "$n.Icon = [System.Drawing.SystemIcons]::Information; "
    "$n.Visible = $true; "
    f"$n.ShowBalloonTip(5000, $env:{_ENV_TITLE}, $env:{_ENV_MESSAGE}, "
    "[System.Windows.Forms.ToolTipIcon]::Info); "
    "Start-Sleep -Seconds 5; $n.Dispose()"
)


def _run(cmd: list[str], env: dict[str, str] | None = None) -> bool:
    """Run `cmd` to completion; return True iff it spawned and exited 0.

    `env` (if given) is merged OVER the current environment, so the child keeps
    PATH/DISPLAY/etc. and gains the notification vars. Output is captured and
    discarded. A missing binary, non-zero exit, or timeout all return False.
    Never raises.
    """
    try:
        merged = {**os.environ, **env} if env else None
        return subprocess.run(cmd, capture_output=True, timeout=20, env=merged).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _spawn(cmd: list[str], env: dict[str, str] | None = None) -> bool:
    """Spawn `cmd` detached (fire-and-forget); return True iff it launched.

    For the Windows balloon, whose process must outlive this call — so we DON'T
    wait on it. Success means "launched", not "displayed". `env` is merged over
    the current environment as in `_run`. A spawn failure returns False. Never
    raises.
    """
    try:
        merged = {**os.environ, **env} if env else None
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=merged)
        return True
    except OSError:
        return False


def _notify_macos(message: str, title: str) -> str | None:
    """macOS: post a Notification Center banner via osascript. "osascript" or None.

    Exits 0 once the banner is posted; whether it's actually shown depends on the
    user's Notification Center settings for the controlling app (out of our hands).
    """
    env = {_ENV_TITLE: title, _ENV_MESSAGE: message}
    if _run(["osascript", "-e", _MACOS_APPLESCRIPT], env=env):
        return "osascript"
    return None


def _notify_linux(message: str, title: str) -> str | None:
    """Linux: notify-send (libnotify). Title/body are argv. "notify-send" or None."""
    if _run(["notify-send", title, message]):
        return "notify-send"
    return None


def _notify_windows(message: str, title: str) -> str | None:
    """Windows: a detached PowerShell NotifyIcon balloon. "powershell" or None."""
    env = {_ENV_TITLE: title, _ENV_MESSAGE: message}
    if _spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", _WINDOWS_POWERSHELL], env=env):
        return "powershell"
    return None


def _platform_worker() -> Callable[[str, str], str | None]:
    """The per-OS notifier for the current platform.

    A function so callers (and tests) get the right worker by sys.platform without
    threading the branch through `notify()`. An exotic platform returns a worker
    that yields None — there's no desktop notifier to fall back to.
    """
    if sys.platform == "darwin":
        return _notify_macos
    elif sys.platform.startswith("linux"):
        return _notify_linux
    elif sys.platform == "win32":
        return _notify_windows
    else:  # exotic platform: no desktop notifier available
        return lambda message, title: None


def notify(message: str, title: str = _DEFAULT_TITLE) -> str | None:
    """Raise an OS-wide desktop notification; return the mechanism, or None.

    Dispatches to the platform-native notifier (osascript on macOS, notify-send on
    Linux, a PowerShell balloon on Windows). Returns the mechanism's name on
    success, or None when none is available / it failed. Best-effort: never raises.
    """
    return _platform_worker()(message, title)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="os_notify.py",
        description="Raise an OS-wide desktop notification (macOS, Linux, Windows).",
        epilog=(
            "Examples:\n"
            '  os_notify.py "build finished"                 # banner, default title\n'
            '  os_notify.py --title Deploy "shipped to prod" # custom title\n'
            '  os_notify.py -v "tests passed"                # also report which mechanism fired'
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("message", help="the notification body text")
    parser.add_argument("--title", default=_DEFAULT_TITLE, help='banner title (default "PreemDeck")')
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="print which mechanism produced the notification (osascript/notify-send/powershell)",
    )
    ns = parser.parse_args(argv)
    mechanism = notify(ns.message, ns.title)
    if mechanism is None:
        # No desktop notifier available (or it failed) — don't silently lose the
        # message; echo it to stderr and exit non-zero.
        print(f"notify: no desktop notification mechanism available; {ns.title}: {ns.message}", file=sys.stderr)
        return 1
    if ns.verbose:
        print(f"notify: {mechanism}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
