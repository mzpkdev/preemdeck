"""JetBrains IDE detection for the jetbrains-ide toolbox (macOS).

Resolution reads the *running* IDE, not project files: the IDE that opened the
terminal is an ancestor process, so resolve_exec_path() walks up to its binary.
"""

import os
import subprocess
from pathlib import Path

from ._errors import JetBrainsError

# Basenames of JetBrains IDE launchers at <App>.app/Contents/MacOS/<name>.
IDE_BINARIES = frozenset(
    {
        "webstorm",
        "pycharm",
        "idea",
        "goland",
        "phpstorm",
        "rubymine",
        "clion",
        "rider",
        "datagrip",
        "rustrover",
    }
)


def in_jetbrains() -> bool:
    """True when this terminal was launched by a JetBrains IDE."""
    return (
        os.environ.get("__CFBundleIdentifier", "").startswith("com.jetbrains.")  # noqa: SIM112
        or os.environ.get("TERMINAL_EMULATOR") == "JetBrains-JediTerm"
    )


def resolve_exec_path() -> str:
    """Absolute path to the JetBrains IDE binary this hook is running inside.

    The IDE that opened the terminal is an ancestor process; walk the parent
    chain to it. Raises JetBrainsError if no JetBrains IDE is in the ancestry.

    This is the IDE that *launched* the process, not whichever IDE is focused:
    switching focus to another IDE won't retarget it, and quitting the launching
    IDE makes this raise (its orphaned child reparents away) rather than fall
    through to a different IDE.
    """
    pid = os.getpid()
    for _ in range(16):  # bounded climb
        out = subprocess.run(
            ["ps", "-o", "ppid=,comm=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout.split(maxsplit=1)
        if len(out) < 2:
            break
        ppid, exe = out[0], out[1].strip()
        if exe.rpartition("/")[2] in IDE_BINARIES:
            return exe
        pid = int(ppid)
        if pid <= 1:
            break
    raise JetBrainsError("no JetBrains IDE in the process ancestry")


def resolve_log_dir() -> Path:
    """Log dir of the IDE this process is running inside (active product, newest version).

    Keyed off resolve_exec_path(), so it inherits the same anchoring: the IDE
    that launched this process, not whichever is focused.
    """
    product = Path(resolve_exec_path()).stem.lower()
    product = {"idea": "intellijidea"}.get(product, product)
    base = Path.home() / "Library/Logs/JetBrains"
    dirs = sorted(
        (d for d in base.glob("*") if d.is_dir() and d.name.lower().startswith(product)),
        key=lambda d: d.stat().st_mtime,
        reverse=True,
    )
    if not dirs:
        raise JetBrainsError(f"no log dir for {product!r}")
    return dirs[0]
