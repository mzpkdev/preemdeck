#!/usr/bin/env python3
"""preemdeck installer — register marketplace (claude/codex) or install per-extension (gemini) for one harness."""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import NamedTuple

REPO_ROOT = Path(__file__).resolve().parent

MARKETPLACES: list[tuple[str, Path]] = [
    ("chrome", REPO_ROOT / "ripperdoc" / "chrome"),
    ("dock", REPO_ROOT / "ripperdoc" / "dock"),
    ("drivers", REPO_ROOT / "ripperdoc" / "drivers"),
    ("wetware", REPO_ROOT / "ripperdoc" / "wetware"),
    ("firmware", REPO_ROOT / "ripperdoc" / "firmware"),
]

HOSTS = ["claude", "codex", "gemini"]
MARKETPLACE_HOSTS = {"claude", "codex"}

STAGING_ROOT = "root"

CLEANUP_MANIFEST = ".trash"

CHECK = "✓"
CROSS = "✗"


class PluginSpec(NamedTuple):
    name: str
    source_path: Path


def manifest_dir(host: str) -> str:
    return {"claude": ".claude-plugin", "codex": ".agents/plugins"}[host]


def read_plugin_specs(rack_path: Path) -> list[PluginSpec]:
    """Read plugin specs from the rack's Claude marketplace.json (canonical source).

    Claude's schema has the simplest `source: "./path"` strings — Codex/Gemini installs
    derive from the same list. A bucket with no Claude marketplace returns empty.
    """
    manifest = rack_path / ".claude-plugin" / "marketplace.json"
    if not manifest.exists():
        return []
    try:
        data = json.loads(manifest.read_text())
    except json.JSONDecodeError:
        return []
    return [
        PluginSpec(name=entry["name"], source_path=(rack_path / entry["source"]).resolve())
        for entry in data.get("plugins", [])
        if isinstance(entry.get("name"), str) and isinstance(entry.get("source"), str)
    ]


def run_cli(cmd: list[str], dry_run: bool) -> tuple[bool, str]:
    if dry_run:
        return True, ""
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            return True, ""
        return False, (result.stderr.strip() or result.stdout.strip() or "non-zero exit")
    except subprocess.TimeoutExpired:
        return False, "timed out after 10s"
    except FileNotFoundError:
        return False, f"{cmd[0]} not on PATH"


def register_marketplace(host: str, path: Path, dry_run: bool) -> tuple[bool, str]:
    if host not in MARKETPLACE_HOSTS:
        return True, ""
    ok, err = run_cli([host, "plugin", "marketplace", "add", str(path)], dry_run)
    if not ok and "already" in err.lower():
        return True, ""
    return ok, err


def install_plugin(host: str, spec: PluginSpec, marketplace: str, dry_run: bool) -> tuple[bool, str]:
    if host == "gemini":
        return run_cli(["gemini", "extensions", "install", "--path", str(spec.source_path)], dry_run)
    cmd = [host, "plugin", "install", f"{spec.name}@{marketplace}"]
    if host == "claude":
        cmd.extend(["--scope", "user"])
    return run_cli(cmd, dry_run)


def _read_cleanup_patterns(manifest: Path) -> list[str]:
    patterns: list[str] = []
    for raw in manifest.read_text().splitlines():
        line = raw.split("#", 1)[0].strip()
        if line:
            patterns.append(line)
    return patterns


def _remove_path(path: Path, dry_run: bool) -> bool:
    if path.is_symlink() or not path.exists():
        return False
    if dry_run:
        return True
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()
    return True


def cleanup_after_install(repo_root: Path, dry_run: bool) -> int:
    """Remove paths listed in .trash. Returns count of items removed.

    Patterns are globs relative to repo_root (one per line, `#` comments). Patterns
    containing `..` or starting with `/` are rejected. Matches that resolve outside
    repo_root or that are symlinks are skipped. Missing entries are not an error.
    """
    manifest = repo_root / CLEANUP_MANIFEST
    if not manifest.exists():
        return 0

    repo_root_resolved = repo_root.resolve()
    removed = 0
    for pattern in _read_cleanup_patterns(manifest):
        if pattern.startswith("/") or ".." in Path(pattern).parts:
            print(f"  {CROSS} cleanup: refusing unsafe pattern {pattern!r}", file=sys.stderr)
            continue
        for match in sorted(repo_root.glob(pattern), reverse=True):
            try:
                resolved = match.resolve()
            except OSError:
                continue
            if not resolved.is_relative_to(repo_root_resolved) or resolved == repo_root_resolved:
                continue
            if _remove_path(match, dry_run):
                removed += 1
    if not dry_run:
        manifest.unlink()
    return removed


def unpack_harness(harness: str, repo_root: Path, dry_run: bool) -> tuple[bool, str]:
    """Unpack the per-harness staging tree into the repo root.

    `root/<harness>/` mirrors what should sit at repo root for the chosen harness
    (e.g. `root/claude/settings.json`, `root/claude/agents/*.md`). Walk it, move
    every file up to its corresponding path under repo_root, then drop all
    `root/<host>/` directories.

    Idempotent: if `root/<harness>/` is missing, treat as already done. If only
    another harness's staging dir is present, that's a misconfiguration. Existing
    destinations (left from a prior unpack, e.g. after `update.py` re-runs) are
    overwritten.
    """
    src_dir = repo_root / STAGING_ROOT / harness
    if not src_dir.exists():
        others = [h for h in HOSTS if h != harness and (repo_root / STAGING_ROOT / h).exists()]
        if others:
            other_paths = ", ".join(f"{STAGING_ROOT}/{h}/" for h in others)
            return False, f"missing {STAGING_ROOT}/{harness}/ (found {other_paths} — wrong harness?)"
        return True, ""

    if dry_run:
        return True, ""

    for src_file in sorted(src_dir.rglob("*")):
        if src_file.is_dir():
            continue
        rel = src_file.relative_to(src_dir)
        dst = repo_root / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.is_symlink() or dst.exists():
            if dst.is_dir() and not dst.is_symlink():
                shutil.rmtree(dst)
            else:
                dst.unlink()
        shutil.move(str(src_file), str(dst))

    for host in HOSTS:
        host_dir = repo_root / STAGING_ROOT / host
        if host_dir.exists():
            shutil.rmtree(host_dir)

    return True, ""


def bootstrap_workspace(repo_root: Path, dry_run: bool) -> None:
    """Install every workspace package's runtime deps into the shared .venv via uv.

    The repo is a uv workspace (root pyproject `[tool.uv.workspace]`); `uv sync
    --all-packages --no-dev` resolves and installs each app's deps (e.g. wire's
    fastapi/uvicorn/pydantic) without the root dev group. Non-fatal: a missing uv
    or a failed sync prints a warning and lets the install continue.
    """
    if shutil.which("uv") is None:
        print(f"  {CROSS} uv not found — skipping dependency bootstrap; install uv and re-run")
        return
    if dry_run:
        print(f"  (dry-run) would run: uv sync --all-packages --no-dev (cwd={repo_root})")
        return
    try:
        result = subprocess.run(
            ["uv", "sync", "--all-packages", "--no-dev"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=300,
        )
    except subprocess.TimeoutExpired:
        print(f"  {CROSS} dependency bootstrap timed out after 300s", file=sys.stderr)
        return
    if result.returncode == 0:
        print(f"  {CHECK} dependency bootstrap: synced workspace packages")
    else:
        tail = (result.stderr.strip() or result.stdout.strip() or "non-zero exit").splitlines()[-5:]
        print(f"  {CROSS} dependency bootstrap failed:", file=sys.stderr)
        for line in tail:
            print(f"      {line}", file=sys.stderr)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Register preemdeck marketplace (claude/codex) or install per-extension (gemini) for one harness.",
    )
    parser.add_argument("harness", choices=HOSTS, help="Target harness")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be done without executing",
    )
    return parser.parse_args()


def print_summary(harness: str, results: dict[str, str]) -> None:
    print()
    print("preemdeck install — done")
    print()
    marks = [f"{CHECK if results.get(name) == 'ok' else CROSS} {name}" for name, _ in MARKETPLACES]
    print(f"  {harness:7s} " + "  ".join(marks))

    errors = [
        f"  {harness} / {name}: {status}"
        for name, _ in MARKETPLACES
        if (status := results.get(name, "")) and status != "ok"
    ]
    if errors:
        print()
        print("Errors:")
        for line in errors:
            print(line)

    print()
    print("  Restart your CLI to load.")
    print()


def install_for(harness: str, dry_run: bool) -> int:
    if not shutil.which(harness):
        print(f"{harness} not on PATH. Install it and re-run.", file=sys.stderr)
        return 1

    print(f"preemdeck install — target: {harness}")
    if dry_run:
        print("  (dry-run — no changes will be made)")
    print()

    bootstrap_workspace(REPO_ROOT, dry_run)

    ok, err = unpack_harness(harness, REPO_ROOT, dry_run)
    if not ok:
        print(f"  {CROSS} unpack: {err}", file=sys.stderr)
        return 1

    results: dict[str, str] = {}
    any_success = False

    for name, path in MARKETPLACES:
        ok, err = register_marketplace(harness, path, dry_run)
        if ok:
            results[name] = "ok"
            any_success = True
            for spec in read_plugin_specs(path):
                p_ok, p_err = install_plugin(harness, spec, name, dry_run)
                if not p_ok and "already" not in p_err.lower() and "exists" not in p_err.lower():
                    results[name] = f"{spec.name}: {p_err}"[:60]
        else:
            results[name] = err[:60]

    print_summary(harness, results)
    removed = cleanup_after_install(REPO_ROOT, dry_run)
    if removed:
        verb = "would remove" if dry_run else "removed"
        print(f"  {CHECK} cleanup: {verb} {removed} item{'s' if removed != 1 else ''}")
        print()
    return 0 if any_success else 1


def main() -> int:
    args = parse_args()
    return install_for(args.harness, args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
