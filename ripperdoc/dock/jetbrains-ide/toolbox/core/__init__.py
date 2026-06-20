"""JetBrains IDE toolbox - public API; delegates to the current platform."""

import sys

from ._errors import JetBrainsError

if sys.platform == "darwin":
    from ._mac import in_jetbrains, resolve_exec_path, resolve_log_dir
elif sys.platform.startswith("linux"):
    from ._linux import in_jetbrains, resolve_exec_path, resolve_log_dir
elif sys.platform == "win32":
    from ._windows import in_jetbrains, resolve_exec_path, resolve_log_dir
else:
    raise ImportError(f"Only macOS, Linux, and Windows are supported (got {sys.platform!r})")

__all__ = ["JetBrainsError", "in_jetbrains", "resolve_exec_path", "resolve_log_dir"]
