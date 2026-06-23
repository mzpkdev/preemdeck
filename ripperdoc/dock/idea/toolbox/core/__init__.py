"""JetBrains IDE toolbox — public API; delegates to the current platform.

Re-exports the detection surface (in_idea, resolve_exec_path,
resolve_log_dir) from the matching per-OS module, plus the cross-platform
launch() / reap_later() helpers, the shared ideScript bridge (escape_groovy /
run_groovy), and the shared IdeaError. Importing on an unsupported platform
raises ImportError.
"""

import sys

from ._errors import IdeaError

if sys.platform == "darwin":
    from .idea_mac import in_idea, resolve_exec_path, resolve_log_dir
elif sys.platform.startswith("linux"):
    from .idea_linux import in_idea, resolve_exec_path, resolve_log_dir
else:
    raise ImportError(f"Only macOS and Linux are supported (got {sys.platform!r})")

# Cross-platform (no per-OS split). _launch imports resolve_exec_path lazily,
# inside launch(), to avoid a cycle with this module, so it's import-safe here.
# _groovy is the shared ideScript bridge built on _launch/_reap (importing them
# directly, not via this module), so it's import-safe here too. _preview reuses
# _groovy's run_groovy / escape_groovy (importing them directly), so it's
# import-safe as well.
from ._groovy import escape_groovy, run_groovy
from ._launch import launch
from ._preview import preview_url, set_preview, webpreview_open_body
from ._reap import reap_later

__all__ = [
    "IdeaError",
    "escape_groovy",
    "in_idea",
    "launch",
    "preview_url",
    "reap_later",
    "resolve_exec_path",
    "resolve_log_dir",
    "run_groovy",
    "set_preview",
    "webpreview_open_body",
]
