"""Shared ideScript bridge: escape a Groovy literal + run a one-shot script.

Neutral infra the in-IDE features build on, not tied to any one of them: escape a
string for safe embedding in a Groovy double-quoted literal, and run a one-shot
Groovy script against the live IntelliJ Platform API. The IDE binary evaluates
the script via `ideScript` (its output lands in idea.log); the script reaches
Groovy by spilling to a temp `.groovy`, blocking on the run, then handing the
temp to the deferred reaper. _preview and notify both layer their templates on
this bridge.
"""

import os
import sys
import tempfile

from ._errors import IdeaError
from ._launch import launch
from ._reap import reap_later


def escape_groovy(literal: str) -> str:
    """Escape `literal` for safe embedding inside a Groovy double-quoted string.

    Backslashes first (so an escaped quote's backslash isn't re-escaped), then
    double quotes — the same rule the path literals use, hoisted out so the URL
    and tab-title templates share one escaper.
    """
    return literal.replace("\\", "\\\\").replace('"', '\\"')


def run_groovy(groovy: str, *, note: str) -> None:
    """Run a one-shot `groovy` script in the live IDE; never raise.

    The shared scaffolding behind set_preview/preview_url: spill `groovy` to a
    temp `.groovy`, run it via `launch(["ideScript", script], wait=True)` (block
    until the IDE has evaluated it), then hand the temp to the deferred reaper
    rather than racing the IDE's async read (mirrors open_inline).

    A missing live IDE (IdeaError), an unimplemented platform
    (NotImplementedError), or an OS error spawning the launcher is swallowed with
    a `{note}` stderr line — the function never raises. Callers that have a
    fallback (set_preview) let the note stand; callers that don't (preview_url
    via open_url) treat the note as a hard failure at the CLI boundary.
    """
    fd, script = tempfile.mkstemp(suffix=".groovy")
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(groovy)
        try:
            launch(["ideScript", script], wait=True)
        except (IdeaError, NotImplementedError, OSError) as exc:
            print(f"{note} ({exc})", file=sys.stderr)
    finally:
        # ideScript forwards to the running IDE async; hand the temp to the
        # deferred reaper rather than racing the read (mirrors open_inline).
        reap_later([script])
