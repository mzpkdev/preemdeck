#!/usr/bin/env python3
"""Canonicalize tracked JSON files using `python -m json.tool`.

Discovers every `*.json` file via `git ls-files` (so untracked / ignored files
are skipped automatically) and rewrites each one with 2-space indent and a
trailing newline. Key order is preserved — plugin manifests have meaningful
ordering and `--sort-keys` would scramble them. Files whose canonical form
already matches their on-disk content are left untouched to keep mtimes stable.

Invalid JSON is reported to stderr but does not abort the rest of the run.
Exit code is non-zero if any file failed to parse.

Usage:
    uv run python scripts/format_json.py [path ...]

When invoked with explicit paths, only those that are tracked JSON files get
processed. With no args, every tracked `*.json` is formatted.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
INDENT = 2


def _tracked_json_files() -> list[Path]:
    out = subprocess.check_output(
        ["git", "ls-files", "*.json"],
        cwd=REPO_ROOT,
        text=True,
    )
    return [REPO_ROOT / line for line in out.splitlines() if line]


def _canonicalize(path: Path) -> bool:
    """Rewrite `path` in canonical form. Return True if the file was changed."""
    original = path.read_text(encoding="utf-8")
    data = json.loads(original)
    canonical = json.dumps(data, indent=INDENT, ensure_ascii=False) + "\n"
    if canonical == original:
        return False
    path.write_text(canonical, encoding="utf-8")
    return True


def format_paths(paths: list[Path]) -> tuple[list[Path], list[tuple[Path, str]]]:
    """Format the given JSON files. Returns (changed, failures)."""
    changed: list[Path] = []
    failures: list[tuple[Path, str]] = []
    for path in paths:
        if not path.is_file():
            continue
        try:
            if _canonicalize(path):
                changed.append(path)
        except (json.JSONDecodeError, OSError) as exc:
            failures.append((path, str(exc)))
    return changed, failures


def main(argv: list[str]) -> int:
    if argv:
        tracked = {p.resolve() for p in _tracked_json_files()}
        paths = [Path(arg).resolve() for arg in argv]
        paths = [p for p in paths if p in tracked and p.suffix == ".json"]
    else:
        paths = _tracked_json_files()

    changed, failures = format_paths(paths)

    for path in changed:
        print(f"reformatted {path.relative_to(REPO_ROOT)}")
    for path, msg in failures:
        print(f"format_json: {path.relative_to(REPO_ROOT)}: {msg}", file=sys.stderr)

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
