#!/usr/bin/env python3
"""preemdeck installer — register marketplace (claude/codex) or install per-extension (gemini) for one harness."""

import argparse
import json
import shutil
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import NamedTuple

# Where preemdeck's source lives. Under the decoupled layout boot.sh clones to
# ~/.preemdeck, so __file__ resolves there — distinct from any host config dir.
REPO_ROOT = Path(__file__).resolve().parent

# Rack paths are absolute and rooted at REPO_ROOT (~/.preemdeck/ripperdoc/<rack>).
# Plugins register/install by this absolute path, so the host's plugin cache points
# back into ~/.preemdeck — intentional: the source stays put, nothing is squatted.
MARKETPLACES: list[tuple[str, Path]] = [
    ("chrome", REPO_ROOT / "ripperdoc" / "chrome"),
    ("dock", REPO_ROOT / "ripperdoc" / "dock"),
    ("drivers", REPO_ROOT / "ripperdoc" / "drivers"),
    ("wetware", REPO_ROOT / "ripperdoc" / "wetware"),
    ("firmware", REPO_ROOT / "ripperdoc" / "firmware"),
]

# Host config dirs, relative to the user's home. config_dir() resolves these
# cross-platform via Path.home() — these are the overlay copy destinations.
CONFIG_DIRNAMES = {"claude": ".claude", "codex": ".codex", "gemini": ".gemini"}

HOSTS = ["claude", "codex", "gemini"]
MARKETPLACE_HOSTS = {"claude", "codex"}

# Overlay source: `root/<harness>/` is COPIED into config_dir by copy_overlay().
# This tree is part of preemdeck's PERSISTENT source — it is read on every
# install/update and must survive (never cleaned up). See copy_overlay().
STAGING_ROOT = "root"

# Install manifest: records what each install wrote (overlay files + their
# backups, registered marketplaces, installed plugins) so update.py / uninstall.py
# can read it back. Lives at REPO_ROOT and is keyed + MERGED per harness.
MANIFEST_FILE = ".install-manifest.json"
MANIFEST_SCHEMA = 1

DISABLED_PLUGINS: frozenset[str] = frozenset(
    {"ghost"}
)  # hardcoded skip — never install these, regardless of marketplace.json

CHECK = "✓"
CROSS = "✗"


class PluginSpec(NamedTuple):
    name: str
    source_path: Path


def manifest_dir(host: str) -> str:
    return {"claude": ".claude-plugin", "codex": ".agents/plugins"}[host]


def config_dir(harness: str) -> Path:
    """Resolve the host's config dir (~/.claude, ~/.codex, ~/.gemini).

    Cross-platform: joins the dirname onto Path.home() via pathlib, no hardcoded
    separators. This is the overlay copy destination — never preemdeck's source.
    """
    return Path.home() / CONFIG_DIRNAMES[harness]


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
        if isinstance(entry.get("name"), str)
        and isinstance(entry.get("source"), str)
        and entry["name"] not in DISABLED_PLUGINS
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


def _load_manifest(repo_root: Path) -> dict:
    """Read the install manifest, returning an empty skeleton if absent/corrupt."""
    path = repo_root / MANIFEST_FILE
    if path.exists():
        try:
            data = json.loads(path.read_text())
            if isinstance(data, dict) and isinstance(data.get("harnesses"), dict):
                return data
        except json.JSONDecodeError:
            pass
    return {"schema": MANIFEST_SCHEMA, "harnesses": {}}


def _backup_path(dst: Path) -> Path:
    """Pick a backup path for dst, mirroring boot.sh's `.bak` → `.bak.<ts>` scheme.

    First clobber of a pre-existing file lands at `<dst>.bak`; if that already
    exists, fall back to `<dst>.bak.<unix_ts>` so an earlier backup is never lost.
    """
    primary = dst.with_name(dst.name + ".bak")
    if not primary.exists():
        return primary
    return dst.with_name(f"{dst.name}.bak.{int(time.time())}")


def copy_overlay(harness: str, repo_root: Path, config_dir: Path, dry_run: bool) -> tuple[bool, str, list[dict]]:
    """Copy the per-harness overlay `root/<harness>/*` into the host config dir.

    Under the decoupled layout the overlay is COPIED out of preemdeck's source
    (`root/<harness>/`) into the host's config dir — it never mutates repo_root.

    Policy:
      * Hard-overwrite (no merging).
      * Backup-once before clobbering: the first time we overwrite a genuinely
        pre-existing user file (one with no prior manifest record) we copy it to
        `<dst>.bak` (or `<dst>.bak.<ts>` if `.bak` is taken). Files we wrote on a
        prior run — i.e. files already recorded in this harness's overlay manifest
        — are NOT re-backed-up; they are just re-overwritten.
      * Cross-platform: pathlib + shutil.copy2, mkdir(parents=True), no symlinks.

    Returns (ok, err, records) where each record is
    `{"dst": <abs str>, "src": <repo-rel str>, "backup": <abs str|null>,
      "action": "create"|"overwrite"}` — the overlay slice of the manifest.
    """
    src_root = repo_root / STAGING_ROOT / harness
    if not src_root.is_dir():
        # No overlay for this harness is fine — nothing to copy.
        return True, "", []

    # Files we previously wrote for this harness must not be treated as
    # pre-existing user files, so we never back up our own output.
    prior = _load_manifest(repo_root)["harnesses"].get(harness, {})
    own_writes = {rec["dst"] for rec in prior.get("overlay", []) if rec.get("dst")}

    records: list[dict] = []
    try:
        for src in sorted(p for p in src_root.rglob("*") if p.is_file()):
            rel = src.relative_to(src_root)
            dst = config_dir / rel
            dst_abs = str(dst)
            existed = dst.exists()
            backup: str | None = None

            if existed and dst_abs not in own_writes:
                bak = _backup_path(dst)
                backup = str(bak)
                if not dry_run:
                    shutil.copy2(dst, bak)

            if not dry_run:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)

            records.append(
                {
                    "dst": dst_abs,
                    "src": str(src.relative_to(repo_root)),
                    "backup": backup,
                    "action": "overwrite" if existed else "create",
                }
            )
    except OSError as exc:
        return False, f"overlay copy failed: {exc}", records

    return True, "", records


def write_manifest(
    repo_root: Path,
    harness: str,
    overlay: list[dict],
    marketplaces: list[str],
    plugins: list[dict],
    dry_run: bool,
) -> None:
    """Merge this install's record into the per-harness manifest at REPO_ROOT.

    Keyed by harness and MERGED: re-installing one harness leaves every other
    harness's record intact. Skips the write on a dry run (prints intent).
    """
    if dry_run:
        print(f"  (dry-run) would record manifest for {harness}: {len(overlay)} overlay file(s)")
        return
    manifest = _load_manifest(repo_root)
    manifest["schema"] = MANIFEST_SCHEMA
    manifest["harnesses"][harness] = {
        "installed_at": datetime.now(UTC).isoformat(),
        "overlay": overlay,
        "marketplaces": marketplaces,
        "plugins": plugins,
    }
    (repo_root / MANIFEST_FILE).write_text(json.dumps(manifest, indent=2) + "\n")


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

    ok, err, overlay = copy_overlay(harness, REPO_ROOT, config_dir(harness), dry_run)
    if not ok:
        print(f"  {CROSS} overlay: {err}", file=sys.stderr)
        return 1

    results: dict[str, str] = {}
    any_success = False
    registered_marketplaces: list[str] = []
    installed_plugins: list[dict] = []

    for name, path in MARKETPLACES:
        ok, err = register_marketplace(harness, path, dry_run)
        if ok:
            results[name] = "ok"
            any_success = True
            if harness in MARKETPLACE_HOSTS:
                registered_marketplaces.append(name)
            for spec in read_plugin_specs(path):
                p_ok, p_err = install_plugin(harness, spec, name, dry_run)
                if p_ok or "already" in p_err.lower() or "exists" in p_err.lower():
                    installed_plugins.append({"host": harness, "rack": name, "name": spec.name})
                else:
                    results[name] = f"{spec.name}: {p_err}"[:60]
        else:
            results[name] = err[:60]

    print_summary(harness, results)
    write_manifest(REPO_ROOT, harness, overlay, registered_marketplaces, installed_plugins, dry_run)
    return 0 if any_success else 1


def main() -> int:
    args = parse_args()
    return install_for(args.harness, args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
