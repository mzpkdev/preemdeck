#!/usr/bin/env python3
"""preemdeck updater — pull latest source and re-run install for every installed harness."""

import argparse
import subprocess
import sys
from pathlib import Path

import install

REPO_ROOT = Path(__file__).resolve().parent


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Pull latest preemdeck source and re-register marketplace/extensions for installed harnesses.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be done without executing",
    )
    return parser.parse_args()


def installed_harnesses() -> list[str]:
    """Read installed harnesses from the manifest at REPO_ROOT.

    The decoupled layout puts preemdeck's source at ~/.preemdeck, so the harness
    can no longer be inferred from the directory name — the manifest is the source
    of truth. install._load_manifest() returns an empty skeleton on a missing or
    corrupt file, so guard for both that and a schema mismatch here and bail with a
    friendly message pointing back at boot.sh.
    """
    manifest = install._load_manifest(REPO_ROOT)
    harnesses = manifest.get("harnesses") or {}
    if manifest.get("schema") != install.MANIFEST_SCHEMA or not harnesses:
        print(
            f"no install manifest at {REPO_ROOT / install.MANIFEST_FILE} — run boot.sh first",
            file=sys.stderr,
        )
        sys.exit(1)
    return list(harnesses.keys())


def git_pull(dry_run: bool) -> None:
    if dry_run:
        print(f"  (dry-run) would run: git -C {REPO_ROOT} pull --ff-only")
        return
    subprocess.run(
        ["git", "-C", str(REPO_ROOT), "pull", "--ff-only"],
        check=True,
    )


def main() -> int:
    args = parse_args()
    harnesses = installed_harnesses()

    print(f"preemdeck update — harnesses: {', '.join(harnesses)}")
    if args.dry_run:
        print("  (dry-run — no changes will be made)")
    print()

    git_pull(args.dry_run)

    exit_code = 0
    for harness in harnesses:
        exit_code |= install.install_for(harness, args.dry_run)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
