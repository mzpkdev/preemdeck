"""Pop an in-IDE notification balloon in the running JetBrains IDE (best-effort).

A sibling to `preview_url`: instead of opening a tab, it raises a transient
notification balloon in the live IDE via the platform's Notification API. Driven
through the same `ideScript` bridge — the IDE binary evaluates a one-shot Groovy
script against the live IntelliJ Platform API, on the EDT.

The proven handle (validated against a live WebStorm): on the EDT, construct a
`com.intellij.notification.Notification(groupId, title, content, type)` and hand
it to `Notifications.Bus.notify(n, project)`, where `project` is the first open
project (or null when none is open — the Bus accepts a null project and shows the
balloon application-wide). The group id is "idea.toolbox"; the NotificationType is
chosen in Python from a whitelist (never interpolated from raw user input) and
filled into the template as a bare enum token.

`title` and `content` are embedded as escaped Groovy string literals via the
`_escape_groovy` helper shared with _preview, so quotes/backslashes in user input
land as a well-formed literal rather than breaking out of the string.

Execution rides _preview's shared `_run_groovy` scaffolding (spill the script to a
temp `.groovy`, run it via `launch(["ideScript", script], wait=True)`, then defer
the temp to the reaper). Like its siblings it NEVER raises: a missing live IDE
(IdeaError), an unimplemented platform (NotImplementedError), or an OS error
spawning the launcher is swallowed with a short stderr note. The notify.py CLI
guards a live IDE up front (the in_idea() gate) and treats dispatch as success.
"""

from ._preview import _escape_groovy, _run_groovy

# The notification group id the balloon registers under. Matches the ideScript
# bridge's own logging group so the balloon and its log line share a namespace.
NOTIFY_GROUP_ID = "idea.toolbox"

# Allowed --type tokens -> the NotificationType enum constant to embed. A
# whitelist, never raw user input: the value is filled into the template as a
# bare Groovy token (NotificationType.<X>), so only these vetted constants can
# ever reach the script.
NOTIFICATION_TYPES = {
    "info": "INFORMATION",
    "warning": "WARNING",
    "error": "ERROR",
}

# Groovy run on the EDT against the live IntelliJ Platform API. {title} and
# {content} are filled with escaped Groovy string literals; {type} is a vetted
# NotificationType constant from NOTIFICATION_TYPES (never raw input). The first
# open project (or null when none is open) scopes the balloon; Bus.notify accepts
# a null project and shows it application-wide.
_GROOVY_NOTIFY = """\
import com.intellij.notification.Notification
import com.intellij.notification.NotificationType
import com.intellij.notification.Notifications
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.ProjectManager

ApplicationManager.getApplication().invokeLater {{
    def projects = ProjectManager.getInstance().getOpenProjects()
    def project = projects.length > 0 ? projects[0] : null
    def n = new Notification("{group}", "{title}", "{content}", NotificationType.{type})
    Notifications.Bus.notify(n, project)
}}
"""


def _groovy_for(title: str, message: str, type_token: str) -> str:
    """Render the notification Groovy for `title`/`message`/`type_token`.

    `title` and `message` are escaped as Groovy string literals; `type_token` is
    the caller's already-vetted key into NOTIFICATION_TYPES, mapped here to the
    NotificationType constant embedded as a bare token. KeyError on an unknown
    token is a programming error (the CLI only ever passes a whitelisted key).
    """
    return _GROOVY_NOTIFY.format(
        group=_escape_groovy(NOTIFY_GROUP_ID),
        title=_escape_groovy(title),
        content=_escape_groovy(message),
        type=NOTIFICATION_TYPES[type_token],
    )


def notify(message: str, title: str = "PreemDeck", type_token: str = "info") -> None:
    """Pop an in-IDE notification balloon in the running IDE (best-effort).

    Renders the notification Groovy with `title`/`message` injected (both escaped
    as Groovy string literals) and `type_token` mapped through NOTIFICATION_TYPES
    to a NotificationType constant, then runs it through _preview's shared
    `_run_groovy` scaffolding (blocking ideScript run + deferred reap). The
    platform raises a transient balloon scoped to the first open project (or
    application-wide when none is open).

    Like preview_url, NEVER raises: no live IDE / stub platform / spawn failure is
    swallowed with a stderr note. The notify.py CLI guards a live IDE up front
    (the in_idea() gate) and treats dispatch as success.
    """
    _run_groovy(_groovy_for(title, message, type_token), note="notify: could not pop notification")
