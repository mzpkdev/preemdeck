#!/usr/bin/env python3
"""Format the file just edited by an agent.

Wired into `.claude/settings.json`, `.codex/config.toml`, and `.gemini/settings.json`
as a PostToolUse / AfterTool hook. Always exits 0 — formatter failures warn on
stderr but never block the agent's edit.
"""

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

FORMATTERS: dict[str, list[str]] = {
    ".py": ["uv", "run", "--quiet", "ruff", "format"],
    ".md": ["uv", "run", "--quiet", "mdformat"],
    ".markdown": ["uv", "run", "--quiet", "mdformat"],
    ".json": ["uv", "run", "--quiet", "python", "scripts/format_json.py"],
}

FORMAT_TIMEOUT_SECONDS = 30


def main() -> int:
    payload = _read_payload()
    if payload is None:
        return 0

    file_path = _extract_file_path(payload)
    if file_path is None:
        return 0

    path = _resolve_inside_repo(file_path)
    if path is None:
        return 0

    _format(path)
    return 0


def _read_payload() -> dict | None:
    try:
        payload = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def _extract_file_path(payload: dict) -> str | None:
    tool_input = payload.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        return None
    for key in ("file_path", "absolute_path", "path"):
        value = tool_input.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _resolve_inside_repo(file_path: str) -> Path | None:
    path = Path(file_path).resolve()
    if not path.is_file():
        return None
    try:
        path.relative_to(REPO_ROOT)
    except ValueError:
        return None
    return path


def _format(path: Path) -> None:
    cmd = FORMATTERS.get(path.suffix.lower())
    if cmd is None:
        return
    try:
        subprocess.run(
            [*cmd, str(path)],
            cwd=REPO_ROOT,
            timeout=FORMAT_TIMEOUT_SECONDS,
            check=False,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        print(f"format_on_edit: {path.name}: {exc}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
