#!/usr/bin/env python3
"""Play a short "ding" notification sound — cross-platform (macOS, Linux, Windows).

One job: make an audible "ding" using whatever the host OS already provides, with
no third-party deps. Each platform has its own mechanism, selected by sys.platform:

- macOS:   `afplay` a built-in system sound (/System/Library/Sounds/*.aiff);
           falls back to `osascript -e beep`.
- Windows: the stdlib `winsound` module (MessageBeep) — the system default
           notification sound. No subprocess; always present on Windows.
- Linux:   no universal player, so try a chain (canberra-gtk-play -> paplay ->
           aplay) and use the first that's installed and exits cleanly.

If every OS mechanism is missing or fails, fall back to the ASCII terminal bell
(BEL, "\\a") so *something* fires. Best-effort throughout: a missing player or a
spawn error is swallowed, never raised. `ding()` returns the name of the
mechanism that fired ("afplay"/"winsound"/.../"bell"), so a caller can tell a real
sound from the bell fallback without catching exceptions.
"""

import argparse
import subprocess
import sys
from collections.abc import Callable

# macOS: a built-in system sound that reads as a clean "ding". Glass is the
# canonical notification chime and ships on every macOS; swap for another
# /System/Library/Sounds/*.aiff (Ping, Tink, Pop, ...) to taste.
_MACOS_SOUND = "/System/Library/Sounds/Glass.aiff"

# Linux: ordered candidate commands. The first whose binary exists and exits 0
# wins. canberra plays the freedesktop "bell" sound-theme event; paplay/aplay
# play a concrete file from the shared sound themes (whichever is installed).
_LINUX_CANDIDATES: list[list[str]] = [
    ["canberra-gtk-play", "--id", "bell"],
    ["paplay", "/usr/share/sounds/freedesktop/stereo/bell.oga"],
    ["paplay", "/usr/share/sounds/freedesktop/stereo/complete.oga"],
    ["aplay", "-q", "/usr/share/sounds/alsa/Front_Center.wav"],
]


def _run(cmd: list[str]) -> bool:
    """Run `cmd`, return True iff it spawned and exited 0. Swallows everything.

    The single subprocess seam every macOS/Linux mechanism rides. A missing
    binary (FileNotFoundError), a non-zero exit, or a timeout all return False so
    the caller can try the next candidate or fall back to the bell. Output is
    captured (and discarded) so a player's chatter never reaches the terminal.
    Never raises.
    """
    try:
        return subprocess.run(cmd, capture_output=True, timeout=10).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _winsound_beep() -> bool:
    """Play the Windows default notification beep via the stdlib `winsound`.

    Guarded on win32 (and imported lazily) because `winsound` is a Windows-only
    stdlib module — absent everywhere else, and typeshed hides its members off
    win32, so the guard is also what keeps this type-clean cross-platform. Returns
    False when not on Windows, or if the import or the call fails, so the caller
    can fall back to the bell. Never raises.
    """
    if sys.platform == "win32":
        try:
            import winsound

            winsound.MessageBeep(winsound.MB_OK)
        except (ImportError, RuntimeError):
            return False
        return True
    return False


def _terminal_bell() -> None:
    """Write the ASCII BEL ("\\a") to stderr — the universal last-resort "ding".

    Honored by most terminals (audible or visual bell); a no-op where the bell is
    disabled. stderr, not stdout, so it never pollutes piped output.
    """
    sys.stderr.write("\a")
    sys.stderr.flush()


def _ding_macos() -> str | None:
    """macOS: afplay a built-in system sound; fall back to an osascript beep.

    No up-front file-existence check — a missing .aiff or absent afplay just makes
    `_run` return False, dropping through to osascript. Returns the mechanism that
    fired, or None when both fail (caller rings the bell).
    """
    if _run(["afplay", _MACOS_SOUND]):
        return "afplay"
    if _run(["osascript", "-e", "beep"]):
        return "osascript"
    return None


def _ding_linux() -> str | None:
    """Linux: the first candidate player that's installed and exits 0.

    Returns the winning binary's name, or None when no candidate works (caller
    rings the bell).
    """
    for cmd in _LINUX_CANDIDATES:
        if _run(cmd):
            return cmd[0]
    return None


def _ding_windows() -> str | None:
    """Windows: the stdlib winsound default beep. Returns "winsound" or None."""
    if _winsound_beep():
        return "winsound"
    return None


def _platform_worker() -> Callable[[], str | None]:
    """The per-OS mechanism for the current platform.

    A function so callers (and tests) get the right worker by sys.platform without
    threading the branch through `ding()`. An exotic platform with no native
    mechanism returns a worker that yields None — straight to the bell.
    """
    if sys.platform == "darwin":
        return _ding_macos
    elif sys.platform.startswith("linux"):
        return _ding_linux
    elif sys.platform == "win32":
        return _ding_windows
    else:  # exotic platform: no native mechanism, fall through to the bell
        return lambda: None


def ding() -> str:
    """Play the host OS's notification "ding"; return the mechanism that fired.

    Tries the platform-native mechanism first (afplay/osascript on macOS, winsound
    on Windows, a player chain on Linux). If none is available or all fail, writes
    the ASCII terminal bell and returns "bell" — so a caller always gets *some*
    audible cue and `ding()` never raises.
    """
    mechanism = _platform_worker()()
    if mechanism is None:
        _terminal_bell()
        return "bell"
    return mechanism


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="os_ding.py",
        description="Play a short notification 'ding' using the host OS's built-in sound.",
        epilog=(
            "Examples:\n"
            "  os_ding.py            # play the ding\n"
            "  os_ding.py -v         # play it and report which mechanism fired"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="print which mechanism produced the sound (afplay/winsound/.../bell)",
    )
    ns = parser.parse_args(argv)
    # ding() is best-effort and never raises: the bell is the floor, so there's
    # nothing to fail on and main always exits 0.
    mechanism = ding()
    if ns.verbose:
        print(f"ding: {mechanism}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
