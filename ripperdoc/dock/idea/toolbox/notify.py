#!/usr/bin/env python3
"""Pop an in-IDE notification balloon in the running JetBrains IDE.

A sibling to `open_url`: instead of opening a tab, it raises a transient
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

The balloon can carry clickable action buttons, selected from a vetted registry
(NOTIFICATION_ACTIONS) via the repeatable `--action name[=arg]` flag. Each action
renders to a `NotificationAction.createSimple(label, { ... } as Runnable)` line
injected between the `new Notification(...)` and `Notifications.Bus.notify(...)`
calls: "open-url" browses to a URL in the external browser, "open-file" opens a
path in the editor, and "open-preview" opens a URL in the IDE's JCEF web-preview
tab — the last reuses the SAME WebPreview mechanism as `preview_url` (the shared
`webpreview_open_body` fragment) so the two can't drift. The action `name` is
whitelisted in Python; the `arg` is escaped (never a bare token), the label is a
static registry string.

`title`, `content`, and each action `arg` are embedded as escaped Groovy string
literals via the `escape_groovy` helper from the shared core bridge, so
quotes/backslashes in user input land as a well-formed literal rather than
breaking out of the string.

Execution rides core's shared `run_groovy` scaffolding (spill the script to a
temp `.groovy`, run it via `launch(["ideScript", script], wait=True)`, then defer
the temp to the reaper). Like its siblings it NEVER raises: a missing live IDE
(IdeaError), an unimplemented platform (NotImplementedError), or an OS error
spawning the launcher is swallowed with a short stderr note. The CLI guards a
live IDE up front (the in_idea() gate) and treats dispatch as success.
"""

import argparse
import sys

from core import IdeaError, escape_groovy, in_idea, run_groovy, webpreview_open_body

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

# Allowed --action names -> the clickable button to add to the balloon. A
# whitelist mirroring NOTIFICATION_TYPES: the CLI validates `name` against these
# keys (unknown -> usage error) so only vetted closures ever reach the script.
# Each entry is (label, needs_arg, body):
#   - label: the static button text (a registry string, NOT user input).
#   - needs_arg: whether `--action name=arg` must carry an arg (all three do).
#   - body: the Groovy closure body run when the button is clicked, with one
#     {arg} slot filled by the escaped CLI arg. Bodies use fully-qualified class
#     names (no imports) and re-fetch the project INSIDE the closure, since it
#     runs long after the notification was built.
#
# "open-preview" deliberately reuses `webpreview_open_body` — the SAME fragment
# `_preview._GROOVY_URLPREVIEW` (and thus preview_url) composes — so the
# web-preview mechanism is a single source of truth and the action can't drift
# from `preview_url`. Its body is filled in below (it needs the shared fragment,
# not a static template).
# Closure-body locals are prefixed `action*` so re-fetching the project INSIDE the
# closure does not re-declare `projects`/`project` from the enclosing invokeLater
# scope — Groovy forbids shadowing an enclosing-scope variable (a compile error,
# caught only at IDE eval, not in Python).
_OPEN_FILE_BODY = """\
def actionProjects = com.intellij.openapi.project.ProjectManager.getInstance().getOpenProjects()
if (actionProjects.length == 0) return
def actionProject = actionProjects[0]
def vf = com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByPath("{arg}")
if (vf == null) return
com.intellij.openapi.fileEditor.FileEditorManager.getInstance(actionProject).openFile(vf, true)\
"""

# The "open-preview" closure body: fetch the project (under action*-prefixed names
# so it doesn't shadow the enclosing invokeLater scope's `project`/`projects` — a
# Groovy compile error), then splice in the shared WebPreview-open fragment
# (parity with preview_url), pointed at that re-fetched project. {arg} is the URL;
# the tab title reuses the same URL literal (the platform shows "Preview of
# <url>"). Built here rather than inline so the {arg} slot lands in BOTH the url
# and title.
_OPEN_PREVIEW_BODY = (
    "def actionProjects = com.intellij.openapi.project.ProjectManager.getInstance().getOpenProjects()\n"
    "if (actionProjects.length == 0) return\n"
    "def actionProject = actionProjects[0]\n" + webpreview_open_body("{arg}", "{arg}", project_var="actionProject")
)

NOTIFICATION_ACTIONS = {
    "open-url": ("Open in browser", True, 'com.intellij.ide.BrowserUtil.browse("{arg}")'),
    "open-file": ("Open file", True, _OPEN_FILE_BODY),
    "open-preview": ("Open preview", True, _OPEN_PREVIEW_BODY),
}

# Groovy run on the EDT against the live IntelliJ Platform API. {title} and
# {content} are filled with escaped Groovy string literals; {type} is a vetted
# NotificationType constant from NOTIFICATION_TYPES (never raw input). {actions}
# is zero-or-more rendered `n.addAction(...)` lines (empty when no --action is
# given, leaving the render byte-identical to the action-less path). The first
# open project (or null when none is open) scopes the balloon; Bus.notify accepts
# a null project and shows it application-wide.
_GROOVY_NOTIFY = """\
import com.intellij.notification.Notification
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationType
import com.intellij.notification.Notifications
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.ProjectManager

ApplicationManager.getApplication().invokeLater {{
    def projects = ProjectManager.getInstance().getOpenProjects()
    def project = projects.length > 0 ? projects[0] : null
    def n = new Notification("{group}", "{title}", "{content}", NotificationType.{type}){actions}
    Notifications.Bus.notify(n, project)
}}
"""


def _parse_action(value: str) -> tuple[str, str | None]:
    """Split a `--action` value into `(name, arg)`, on the FIRST `=` only.

    `name=arg` -> `(name, arg)`; a bare `name` -> `(name, None)`. Splitting on the
    first `=` keeps URLs/paths (which contain `=`, e.g. query strings) intact in
    the arg. Validation of the name and arg-presence happens in `_validate_action`
    so an argparse type= callback can raise a clean usage error.
    """
    name, sep, arg = value.partition("=")
    return name, arg if sep else None


def _validate_action(value: str) -> tuple[str, str | None]:
    """argparse `type=` callback: parse + whitelist a `--action` value.

    Returns the `(name, arg)` pair for the appended list, or raises
    `argparse.ArgumentTypeError` (which argparse renders as a usage error, exit 2)
    when the name is not in NOTIFICATION_ACTIONS or a required arg is missing.
    """
    name, arg = _parse_action(value)
    if name not in NOTIFICATION_ACTIONS:
        allowed = ", ".join(sorted(NOTIFICATION_ACTIONS))
        raise argparse.ArgumentTypeError(f"unknown action {name!r} (choose from {allowed})")
    needs_arg = NOTIFICATION_ACTIONS[name][1]
    if needs_arg and not arg:
        raise argparse.ArgumentTypeError(f"action {name!r} needs an argument: --action {name}=<value>")
    return name, arg


def _render_action(name: str, arg: str | None) -> str:
    """Render one vetted `(name, arg)` action into its `n.addAction(...)` line.

    The label is the static registry string; the closure body is the registry
    template with its `{arg}` slot filled by the escaped arg (so quotes/backslashes
    can't break the Groovy literal). `as Runnable` disambiguates the
    createSimple(String, Runnable) overload. Indented to 4 spaces to sit inside the
    invokeLater block. `arg` is always present for the current registry (every
    action needs one); the `or ""` guards a future arg-less action.
    """
    label, _needs_arg, body_template = NOTIFICATION_ACTIONS[name]
    body = body_template.format(arg=escape_groovy(arg or ""))
    # Indent a multi-line body so every statement sits inside the closure braces.
    indented = "\n".join("        " + line for line in body.splitlines())
    return f'    n.addAction(NotificationAction.createSimple("{label}", {{\n{indented}\n    }} as Runnable))'


def _render_actions(actions: list[tuple[str, str | None]]) -> str:
    """Render the parsed `--action` list to the {actions} block, in CLI order.

    Empty list -> empty string, so the rendered Groovy is byte-identical to the
    action-less path (the {actions} slot is inline after `def n = ...`, so an empty
    string leaves that line untouched — backward compat). Otherwise a leading
    newline plus one `n.addAction(...)` block per action, joined by newlines,
    preserving the order the flags were given.
    """
    if not actions:
        return ""
    return "\n" + "\n".join(_render_action(name, arg) for name, arg in actions)


def _groovy_for(
    title: str,
    message: str,
    type_token: str,
    actions: list[tuple[str, str | None]] | None = None,
) -> str:
    """Render the notification Groovy for `title`/`message`/`type_token`/`actions`.

    `title` and `message` are escaped as Groovy string literals; `type_token` is
    the caller's already-vetted key into NOTIFICATION_TYPES, mapped here to the
    NotificationType constant embedded as a bare token. `actions` is the parsed
    `--action` list (vetted names + escaped args); None/empty renders no action
    buttons. KeyError on an unknown token/name is a programming error (the CLI
    only ever passes whitelisted values).
    """
    return _GROOVY_NOTIFY.format(
        group=escape_groovy(NOTIFY_GROUP_ID),
        title=escape_groovy(title),
        content=escape_groovy(message),
        type=NOTIFICATION_TYPES[type_token],
        actions=_render_actions(actions or []),
    )


def notify(
    message: str,
    title: str = "PreemDeck",
    type_token: str = "info",
    actions: list[tuple[str, str | None]] | None = None,
) -> None:
    """Pop an in-IDE notification balloon for `message` in the running IDE (best-effort).

    FIRE-AND-FORGET: there is no editor or tab to block on — the balloon is a
    transient toast — so unlike open_file there is no `--wait`. `title` defaults
    to "PreemDeck"; `type_token` (info|warning|error) picks the NotificationType
    icon/severity and defaults to "info". `actions` is the parsed `--action` list
    (vetted name + arg pairs); each adds a clickable button to the balloon. None
    leaves the render identical to the action-less path.

    Renders the notification Groovy with `title`/`message` injected (both escaped
    as Groovy string literals), `type_token` mapped through NOTIFICATION_TYPES to a
    NotificationType constant, and `actions` rendered to addAction lines, then runs
    it through core's shared `run_groovy` scaffolding (blocking ideScript run +
    deferred reap). The platform raises a transient balloon scoped to the first
    open project (or application-wide when none is open).

    Like preview_url, NEVER raises: no live IDE / stub platform / spawn failure is
    swallowed with a stderr note. The CLI guards a live IDE up front (the
    in_idea() gate) and treats dispatch as success.
    """
    run_groovy(
        _groovy_for(title, message, type_token, actions),
        note="notify: could not pop notification",
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="notify.py",
        description="Pop an in-IDE notification balloon in the running JetBrains IDE.",
        epilog=(
            "Examples:\n"
            '  notify.py "build finished"                          # info balloon, default title\n'
            '  notify.py --title Deploy "shipped to prod"          # custom title\n'
            '  notify.py --type error "tests failed"               # error severity/icon\n'
            '  notify.py --action open-url=https://ci.example.com "build done"   # browser button\n'
            '  notify.py --action open-preview=http://localhost:3000 "dev up"    # JCEF preview button\n'
            '  notify.py --action open-file=/tmp/build.log "see log"             # editor button\n'
            "  notify.py --action open-file=/tmp/build.log --action open-url=https://ci.example.com \\\n"
            '            --type error "build failed"               # two buttons'
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("message", help="the notification body text")
    parser.add_argument("--title", default="PreemDeck", help='balloon title (default "PreemDeck")')
    parser.add_argument(
        "--type",
        dest="type_token",
        choices=("info", "warning", "error"),
        default="info",
        help="severity -> NotificationType (default info)",
    )
    parser.add_argument(
        "--action",
        dest="actions",
        action="append",
        type=_validate_action,
        metavar="NAME[=ARG]",
        help=(
            "add a clickable button (repeatable); one of "
            "open-url=<url> (open in browser), open-file=<path> (open in editor), "
            "open-preview=<url> (open in the JCEF preview tab)"
        ),
    )
    ns = parser.parse_args(argv)
    try:
        # Cheap CLI gate: fail fast/clean outside a JetBrains terminal, before the
        # ideScript bridge's deeper resolve_exec_path() ancestry walk. Reuse the
        # IdeaError path so the message matches the resolver-triggered failure.
        if not in_idea():
            raise IdeaError("no JetBrains IDE in the process ancestry")
        notify(ns.message, ns.title, ns.type_token, ns.actions)
    except (IdeaError, NotImplementedError) as exc:
        print(f"notify: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
