"""Deferred temp-file cleanup for the toolbox's fire-and-forget (no-wait) modes.

No-wait callers spawn the IDE async and have no signal for when the handed-off
temp is safe to delete. But the IDE reads the file into memory within ~1s of
launch, after which the on-disk copy can be unlinked and the editor keeps
working (it shows a dismissible "deleted from disk" marker). So instead of
leaking the temp, schedule an unlink a short delay after launch.
"""

import threading
import time
from pathlib import Path

REAP_DELAY = 3.0


def reap_later(paths, *, delay: float = REAP_DELAY) -> None:
    """Schedule `paths` to be unlinked `delay` seconds from now; return at once.

    Spawns a NON-DAEMON thread that sleeps `delay`, then unlinks each path with
    `Path(p).unlink(missing_ok=True)`, swallowing any error (the reaper never
    raises). Returns IMMEDIATELY without joining, so fire-and-forget callers stay
    non-blocking. Non-daemon is deliberate: the interpreter waits for the thread
    at process exit, so a CLI's cleanup is guaranteed rather than killed on exit.

    `paths` is any iterable of str/Path; an empty iterable is fine (the thread
    just sleeps and unlinks nothing). The iterable is materialized up front so a
    transient caller-owned generator can't be exhausted before the thread runs.
    """
    targets = list(paths)

    def _reap() -> None:
        time.sleep(delay)
        for path in targets:
            try:
                Path(path).unlink(missing_ok=True)
            except OSError:
                pass  # never raise from the reaper

    threading.Thread(target=_reap, daemon=False).start()
