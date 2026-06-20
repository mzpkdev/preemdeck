"""Launch the running JetBrains IDE (cross-platform), optionally blocking.

Pure stdlib: resolve the IDE binary and spawn it. With `wait=False` (default)
the launch is fire-and-forget; with `wait=True` the IDE's native `--wait` is
appended and the call blocks on `.wait()` until the opened tab/window closes.
"""

import subprocess


def launch(args: list[str], *, wait: bool = False) -> subprocess.Popen:
    """Spawn the running JetBrains IDE with `args`; return the Popen.

    Resolves the IDE binary that launched this terminal and starts it via
    `subprocess.Popen([exec_path, *args])`.

    - `wait=False` (default): fire-and-forget. Returns as soon as the process is
      spawned, without joining (no `.wait()`, no native `--wait`).
    - `wait=True`: appends the IDE's native `--wait` flag at the END of the arg
      vector and calls `.wait()`, blocking until the IDE tab/window CLOSES
      (whether or not the file was edited). Returns the completed Popen.

    resolve_exec_path() is the single guard: it raises JetBrainsError when no
    JetBrains IDE is in the ancestry, and that propagates (callers turn it into a
    CLI exit 1). No second in_jetbrains() check.
    """
    # Function-local import: core/__init__ imports `launch` from this module, so
    # importing resolve_exec_path from the package at module-load time would
    # deadlock the import cycle. Resolve it lazily, at call time, instead.
    from . import resolve_exec_path

    exec_path = resolve_exec_path()
    argv = [exec_path, *args]
    if wait:
        argv.append("--wait")
    proc = subprocess.Popen(argv)
    if wait:
        proc.wait()
    return proc
