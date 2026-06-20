#!/usr/bin/env python3
"""Pop an in-IDE notification balloon in the running JetBrains IDE."""

import argparse
import sys

from core import IdeaError, in_idea, notify


def notify_message(message: str, title: str = "PreemDeck", type_token: str = "info") -> None:
    """Pop an in-IDE notification balloon for `message` in the running IDE.

    FIRE-AND-FORGET: there is no editor or tab to block on — the balloon is a
    transient toast — so unlike open_file there is no `--wait`. `title` defaults
    to "PreemDeck"; `type_token` (info|warning|error) picks the NotificationType
    icon/severity and defaults to "info".

    Thin wrapper over core.notify (the shared ideScript bridge): the CLI guards a
    live IDE up front via the in_idea() gate, so this just delegates. core.notify
    is best-effort and never raises — a JCEF/balloon hiccup degrades to a stderr
    note rather than a failure — and dispatch counts as success.
    """
    notify(message, title, type_token)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="notify.py",
        description="Pop an in-IDE notification balloon in the running JetBrains IDE.",
        epilog=(
            "Examples:\n"
            '  notify.py "build finished"                          # info balloon, default title\n'
            '  notify.py --title Deploy "shipped to prod"          # custom title\n'
            '  notify.py --type error "tests failed"               # error severity/icon'
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
    ns = parser.parse_args(argv)
    try:
        # Cheap CLI gate: fail fast/clean outside a JetBrains terminal, before the
        # ideScript bridge's deeper resolve_exec_path() ancestry walk. Reuse the
        # IdeaError path so the message matches the resolver-triggered failure.
        if not in_idea():
            raise IdeaError("no JetBrains IDE in the process ancestry")
        notify_message(ns.message, ns.title, ns.type_token)
    except (IdeaError, NotImplementedError) as exc:
        print(f"notify: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
