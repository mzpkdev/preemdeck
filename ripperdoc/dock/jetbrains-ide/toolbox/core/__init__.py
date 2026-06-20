"""JetBrains IDE toolbox — public API; delegates to the current platform.

Re-exports the detection surface (in_jetbrains, resolve_exec_path,
resolve_log_dir) from the matching per-OS module, plus the cross-platform
launch() / reap_later() helpers and the shared JetBrainsError. Importing on an
unsupported platform raises ImportError.
"""

import sys

from ._errors import JetBrainsError

if sys.platform == "darwin":
    from .jetbrains_mac import in_jetbrains, resolve_exec_path, resolve_log_dir
elif sys.platform.startswith("linux"):
    from .jetbrains_linux import in_jetbrains, resolve_exec_path, resolve_log_dir
elif sys.platform == "win32":
    from .jetbrains_windows import in_jetbrains, resolve_exec_path, resolve_log_dir
else:
    raise ImportError(f"Only macOS, Linux, and Windows are supported (got {sys.platform!r})")

# Cross-platform (no per-OS split). _launch imports resolve_exec_path lazily,
# inside launch(), to avoid a cycle with this module, so it's import-safe here.
from ._launch import launch
from ._reap import reap_later

__all__ = [
    "JetBrainsError",
    "in_jetbrains",
    "resolve_exec_path",
    "resolve_log_dir",
    "launch",
    "reap_later",
]
