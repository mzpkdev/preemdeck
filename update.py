#!/usr/bin/env python3
"""preemdeck updater — pull latest source and re-run install for this harness."""

import argparse
import subprocess
import sys
from pathlib import Path

import install

REPO_ROOT = Path(__file__).resolve().parent


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Pull latest preemdeck source and re-register marketplace/extensions for this harness.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be done without executing",
    )
    return parser.parse_args()


def detect_harness() -> str:
    name = REPO_ROOT.name.lstrip(".")
    if name not in install.HOSTS:
        print(
            f"Cannot infer harness from {REPO_ROOT.name!r}. Expected ~/.claude, ~/.codex, or ~/.gemini.",
            file=sys.stderr,
        )
        sys.exit(1)
    return name


def git_pull(dry_run: bool) -> None:
    if dry_run:
        print(f"  (dry-run) would fetch + reset --hard origin/HEAD in {REPO_ROOT}")
        return
    subprocess.run(
        ["git", "-C", str(REPO_ROOT), "fetch", "--depth", "1", "--quiet", "origin", "HEAD"],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(REPO_ROOT), "reset", "--hard", "--quiet", "FETCH_HEAD"],
        check=True,
    )


def main() -> int:
    args = parse_args()
    harness = detect_harness()

    print(f"preemdeck update — target: {harness}")
    if args.dry_run:
        print("  (dry-run — no changes will be made)")
    print()

    git_pull(args.dry_run)
    return install.install_for(harness, args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
