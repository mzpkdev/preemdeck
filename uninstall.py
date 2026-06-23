#!/usr/bin/env python3
"""preemdeck uninstaller — reverse an install from the manifest for one or all harnesses.

Reads the install manifest written by install.py (at REPO_ROOT / MANIFEST_FILE) and
inverts it per harness:

  * Overlay: walk the recorded overlay files in REVERSE order. If a file has a
    `backup`, move that backup back over `dst` (restoring the user's original);
    otherwise delete `dst` (a file install created). Tolerates already-gone files.
  * Unregister: best-effort, inverting install's CLI verbs —
        gemini : ["gemini", "extensions", "uninstall", <plugin>]
        claude/codex plugin    : [host, "plugin", "uninstall", <plugin>]
        claude/codex marketplace: [host, "plugin", "marketplace", "remove", <name>]
    The CLI's `marketplace remove` takes the marketplace NAME (verified against
    `claude plugin marketplace --help`); the manifest stores marketplaces by name.
    Missing CLIs or "not found" errors are logged and skipped — one failure never
    aborts the run.
  * Manifest: drop the harness key and rewrite the file (delete it once no
    harnesses remain).

`--purge` does NOT delete the running source dir (this script lives inside it);
it just prints the manual `rm -rf` one-liner after reversing.
"""

import argparse
import json
import shutil
import sys
from pathlib import Path

import install

# uninstall.py lives in the same dir as install.py (~/.preemdeck), so this
# resolves to the same REPO_ROOT — the manifest and rack paths line up.
REPO_ROOT = Path(__file__).resolve().parent

CHECK = install.CHECK
CROSS = install.CROSS


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Reverse a preemdeck install from the manifest for one or all harnesses.",
    )
    parser.add_argument(
        "harness",
        nargs="?",
        choices=install.HOSTS,
        default=None,
        help="Target harness (default: every harness present in the manifest)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be done without executing",
    )
    parser.add_argument(
        "--purge",
        action="store_true",
        help="After reversing, print the manual command to remove the preemdeck source dir",
    )
    return parser.parse_args(argv)


def load_manifest_or_exit() -> dict:
    """Load the manifest, exiting 1 on missing/corrupt/schema-mismatch.

    install._load_manifest returns an empty skeleton for both a missing file and a
    corrupt one, so we can't distinguish them — but either way there is nothing to
    uninstall, which is an error for this tool.
    """
    path = REPO_ROOT / install.MANIFEST_FILE
    if not path.exists():
        print(f"no install manifest at {path} — nothing to uninstall", file=sys.stderr)
        sys.exit(1)
    manifest = install._load_manifest(REPO_ROOT)
    harnesses = manifest.get("harnesses") or {}
    if manifest.get("schema") != install.MANIFEST_SCHEMA or not harnesses:
        print(
            f"install manifest at {path} is empty, corrupt, or has an unsupported schema "
            f"(expected schema {install.MANIFEST_SCHEMA}) — nothing to uninstall",
            file=sys.stderr,
        )
        sys.exit(1)
    return manifest


def reverse_overlay(records: list[dict], dry_run: bool) -> tuple[int, int]:
    """Reverse overlay records (in REVERSE order). Returns (restored, removed).

    For each record, newest-first:
      * backup present -> shutil.move(backup, dst) restores the user's original,
        clobbering whatever install left at dst.
      * no backup       -> delete dst if present (a file install created).
    Cross-platform via pathlib/shutil; already-gone files are tolerated.
    """
    restored = 0
    removed = 0
    for rec in reversed(records):
        dst = Path(rec["dst"])
        backup = rec.get("backup")
        if backup:
            bak = Path(backup)
            if dry_run:
                print(f"    (dry-run) would restore {dst} from backup {bak}")
                restored += 1
                continue
            if bak.exists():
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(bak), str(dst))
                restored += 1
                print(f"    {CHECK} restored {dst} from backup")
            elif dst.exists():
                # Backup vanished but our file is still there — remove it so we
                # don't leave preemdeck's copy masquerading as the user's file.
                dst.unlink()
                removed += 1
                print(f"    {CROSS} backup {bak} missing; removed {dst}")
            else:
                print(f"    - {dst} already gone (backup {bak} also missing)")
        else:
            if dry_run:
                print(f"    (dry-run) would remove {dst}")
                removed += 1
                continue
            if dst.exists():
                dst.unlink()
                removed += 1
                print(f"    {CHECK} removed {dst}")
            else:
                print(f"    - {dst} already gone")
    return restored, removed


def unregister(harness: str, record: dict, dry_run: bool) -> tuple[int, int]:
    """Best-effort unregister of a harness's plugins + marketplaces. Returns counts.

    Inverts install's verbs (add->remove, install->uninstall) and routes every
    command through install.run_cli, which already swallows a missing CLI
    (FileNotFoundError) and a non-zero exit into (False, msg). We additionally treat
    "not found"/"not installed"/"unknown" stderr as already-done. Nothing here
    aborts the run — failures are logged and skipped.
    """
    plugins_done = 0
    markets_done = 0

    # Plugins first (a marketplace may refuse removal while its plugins linger).
    for plugin in record.get("plugins", []):
        name = plugin.get("name")
        if not name:
            continue
        if harness == "gemini":
            cmd = ["gemini", "extensions", "uninstall", name]
        else:
            cmd = [harness, "plugin", "uninstall", name]
        if _run_unregister(cmd, dry_run, f"plugin {name}"):
            plugins_done += 1

    # Marketplaces (claude/codex only — gemini never registered any). The CLI's
    # `marketplace remove` takes the marketplace NAME (not the path `add` was
    # given), and the manifest already stores marketplaces by name ("dock"), so
    # pass the recorded name straight through.
    if harness in install.MARKETPLACE_HOSTS:
        for rack in record.get("marketplaces", []):
            cmd = [harness, "plugin", "marketplace", "remove", rack]
            if _run_unregister(cmd, dry_run, f"marketplace {rack}"):
                markets_done += 1

    return plugins_done, markets_done


def _run_unregister(cmd: list[str], dry_run: bool, label: str) -> bool:
    """Run one unregister command; log + tolerate failure. Returns True if counted."""
    if dry_run:
        print(f"    (dry-run) would run: {' '.join(cmd)}")
        return True
    ok, err = install.run_cli(cmd, dry_run=False)
    lowered = err.lower()
    if ok or any(token in lowered for token in ("not found", "not installed", "no such", "unknown", "does not exist")):
        print(f"    {CHECK} unregistered {label}")
        return True
    print(f"    {CROSS} {label}: {err}", file=sys.stderr)
    return False


def write_manifest(manifest: dict, dry_run: bool) -> None:
    """Persist the mutated manifest, or delete the file when no harnesses remain."""
    path = REPO_ROOT / install.MANIFEST_FILE
    if manifest["harnesses"]:
        if dry_run:
            print(f"  (dry-run) would rewrite manifest: {len(manifest['harnesses'])} harness(es) remain")
            return
        path.write_text(json.dumps(manifest, indent=2) + "\n")
    else:
        if dry_run:
            print(f"  (dry-run) would delete manifest {path} (no harnesses remain)")
            return
        path.unlink(missing_ok=True)


def uninstall_for(harness: str, manifest: dict, dry_run: bool) -> None:
    """Reverse one harness in place: overlay, unregister, then drop its manifest key."""
    record = manifest["harnesses"].get(harness)
    if record is None:
        print(f"  {harness}: not present in manifest — skipping")
        return

    print(f"preemdeck uninstall — target: {harness}")
    print("  reversing overlay:")
    restored, removed = reverse_overlay(record.get("overlay", []), dry_run)

    print("  unregistering:")
    plugins_done, markets_done = unregister(harness, record, dry_run)

    # Mutate the in-memory manifest; the rewrite happens once per run in main().
    if dry_run:
        print(f"  (dry-run) would drop manifest key for {harness}")
    else:
        manifest["harnesses"].pop(harness, None)

    print(
        f"  {harness}: {restored} restored, {removed} removed, "
        f"{plugins_done} plugin(s) + {markets_done} marketplace(s) unregistered"
    )
    print()


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    manifest = load_manifest_or_exit()

    targets = [args.harness] if args.harness is not None else list(manifest["harnesses"].keys())

    print(f"preemdeck uninstall — harnesses: {', '.join(targets)}")
    if args.dry_run:
        print("  (dry-run — no changes will be made)")
    print()

    for harness in targets:
        uninstall_for(harness, manifest, args.dry_run)

    write_manifest(manifest, args.dry_run)

    if args.purge:
        print()
        print("To remove the preemdeck source dir (this script lives inside it), run manually:")
        print(f"  rm -rf {REPO_ROOT}")

    print("Restart your CLI to drop the unregistered plugins.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
