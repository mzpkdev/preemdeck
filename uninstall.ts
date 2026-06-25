#!/usr/bin/env bun
/**
 * uninstall.ts — preemdeck uninstaller (TS port of uninstall.py, behavior-identical v1).
 *
 * Reads the install manifest written by install.ts and inverts it per harness:
 *   * Overlay: walk the recorded overlay files in REVERSE order. With a `backup`,
 *     move it back over `dst` (restoring the user's original); else delete `dst`
 *     (a file install created). Tolerates already-gone files.
 *   * Unregister: best-effort, inverting install's CLI verbs (add->remove,
 *     install->uninstall). Missing CLIs / "not found" are logged and skipped.
 *   * Manifest: drop the harness key and rewrite (delete it once none remain).
 *
 * `--purge` does NOT delete the running source dir (this script lives inside it);
 * it just prints the manual `rm -rf` one-liner after reversing. Additive port —
 * uninstall.py stays the live entrypoint until the flip phase.
 */

import { existsSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  CHECK,
  CROSS,
  HOSTS,
  loadManifest,
  MANIFEST_FILE,
  MANIFEST_SCHEMA,
  MARKETPLACE_HOSTS,
  type Manifest,
  type OverlayRecord,
  runCli,
} from "./install.ts";

// uninstall.ts lives in the same dir as install.ts (~/.preemdeck), so this
// resolves to the same REPO_ROOT — the manifest and rack paths line up.
export const REPO_ROOT = import.meta.dir;

export interface UninstallArgs {
  harness: string | null;
  dryRun: boolean;
  purge: boolean;
}

export function parseUninstallArgs(argv: string[]): UninstallArgs {
  const prog = "uninstall.ts";
  let parsed: ReturnType<
    typeof parseArgs<{
      options: { "dry-run": { type: "boolean" }; purge: { type: "boolean" } };
      allowPositionals: true;
    }>
  >;
  try {
    parsed = parseArgs({
      args: argv,
      options: { "dry-run": { type: "boolean" }, purge: { type: "boolean" } },
      allowPositionals: true,
    });
  } catch (err) {
    process.stderr.write(`${prog}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  const positionals = parsed.positionals;
  let harness: string | null = null;
  if (positionals.length > 0) {
    harness = positionals[0] as string;
    if (!HOSTS.includes(harness)) {
      process.stderr.write(
        `${prog}: argument harness: invalid choice: '${harness}' (choose from ${HOSTS.join(", ")})\n`,
      );
      process.exit(2);
    }
  }
  return { harness, dryRun: parsed.values["dry-run"] === true, purge: parsed.values.purge === true };
}

/**
 * Load the manifest, exiting 1 on missing/corrupt/schema-mismatch.
 *
 * loadManifest returns an empty skeleton for both a missing file and a corrupt
 * one, so we can't distinguish them — but either way there is nothing to
 * uninstall, which is an error for this tool.
 */
export function loadManifestOrExit(repoRoot: string = REPO_ROOT): Manifest {
  const path = join(repoRoot, MANIFEST_FILE);
  if (!existsSync(path)) {
    process.stderr.write(`no install manifest at ${path} — nothing to uninstall\n`);
    process.exit(1);
  }
  const manifest = loadManifest(repoRoot);
  const harnesses = manifest.harnesses ?? {};
  if (manifest.schema !== MANIFEST_SCHEMA || Object.keys(harnesses).length === 0) {
    process.stderr.write(
      `install manifest at ${path} is empty, corrupt, or has an unsupported schema ` +
        `(expected schema ${MANIFEST_SCHEMA}) — nothing to uninstall\n`,
    );
    process.exit(1);
  }
  return manifest;
}

/**
 * Reverse overlay records (in REVERSE order). Returns [restored, removed].
 *
 * Newest-first: backup present -> move(backup, dst) restores the user's original,
 * clobbering whatever install left at dst; no backup -> delete dst if present.
 * Already-gone files are tolerated.
 */
export function reverseOverlay(records: OverlayRecord[], dryRun: boolean): [number, number] {
  let restored = 0;
  let removed = 0;
  for (const rec of [...records].reverse()) {
    const dst = rec.dst;
    const backup = rec.backup;
    if (backup) {
      const bak = backup;
      if (dryRun) {
        console.log(`    (dry-run) would restore ${dst} from backup ${bak}`);
        restored += 1;
        continue;
      }
      if (existsSync(bak)) {
        mkdirSync(dirname(dst), { recursive: true });
        renameSync(bak, dst);
        restored += 1;
        console.log(`    ${CHECK} restored ${dst} from backup`);
      } else if (existsSync(dst)) {
        // Backup vanished but our file is still there — remove it so we don't
        // leave preemdeck's copy masquerading as the user's file.
        unlinkSync(dst);
        removed += 1;
        console.log(`    ${CROSS} backup ${bak} missing; removed ${dst}`);
      } else {
        console.log(`    - ${dst} already gone (backup ${bak} also missing)`);
      }
    } else {
      if (dryRun) {
        console.log(`    (dry-run) would remove ${dst}`);
        removed += 1;
        continue;
      }
      if (existsSync(dst)) {
        unlinkSync(dst);
        removed += 1;
        console.log(`    ${CHECK} removed ${dst}`);
      } else {
        console.log(`    - ${dst} already gone`);
      }
    }
  }
  return [restored, removed];
}

/**
 * Best-effort unregister of a harness's plugins + marketplaces. Returns counts.
 *
 * Inverts install's verbs (add->remove, install->uninstall) and routes every
 * command through install.runCli, which swallows a missing CLI and a non-zero
 * exit into [false, msg]. We additionally treat "not found"/"not installed"/etc.
 * stderr as already-done. Nothing here aborts the run.
 */
export async function unregister(harness: string, record: ManifestRecord, dryRun: boolean): Promise<[number, number]> {
  let pluginsDone = 0;
  let marketsDone = 0;

  // Plugins first (a marketplace may refuse removal while its plugins linger).
  for (const plugin of record.plugins ?? []) {
    const name = (plugin as { name?: unknown }).name;
    if (typeof name !== "string" || !name) {
      continue;
    }
    const cmd =
      harness === "gemini" ? ["gemini", "extensions", "uninstall", name] : [harness, "plugin", "uninstall", name];
    if (await runUnregister(cmd, dryRun, `plugin ${name}`)) {
      pluginsDone += 1;
    }
  }

  // Marketplaces (claude/codex only — gemini never registered any). The CLI's
  // `marketplace remove` takes the marketplace NAME (not the path `add` was
  // given), and the manifest stores marketplaces by name, so pass it straight.
  if (MARKETPLACE_HOSTS.has(harness)) {
    for (const rack of record.marketplaces ?? []) {
      const cmd = [harness, "plugin", "marketplace", "remove", rack];
      if (await runUnregister(cmd, dryRun, `marketplace ${rack}`)) {
        marketsDone += 1;
      }
    }
  }

  return [pluginsDone, marketsDone];
}

/** Run one unregister command; log + tolerate failure. Returns true if counted. */
async function runUnregister(cmd: string[], dryRun: boolean, label: string): Promise<boolean> {
  if (dryRun) {
    console.log(`    (dry-run) would run: ${cmd.join(" ")}`);
    return true;
  }
  const [ok, err] = await runCli(cmd, false);
  const lowered = err.toLowerCase();
  const tolerated = ["not found", "not installed", "no such", "unknown", "does not exist"];
  if (ok || tolerated.some((token) => lowered.includes(token))) {
    console.log(`    ${CHECK} unregistered ${label}`);
    return true;
  }
  process.stderr.write(`    ${CROSS} ${label}: ${err}\n`);
  return false;
}

interface ManifestRecord {
  overlay?: OverlayRecord[];
  marketplaces?: string[];
  plugins?: Array<Record<string, unknown>>;
}

/** Persist the mutated manifest, or delete the file when no harnesses remain. */
export function writeManifest(repoRoot: string, manifest: Manifest, dryRun: boolean): void {
  const path = join(repoRoot, MANIFEST_FILE);
  if (Object.keys(manifest.harnesses).length > 0) {
    if (dryRun) {
      console.log(`  (dry-run) would rewrite manifest: ${Object.keys(manifest.harnesses).length} harness(es) remain`);
      return;
    }
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    if (dryRun) {
      console.log(`  (dry-run) would delete manifest ${path} (no harnesses remain)`);
      return;
    }
    rmSync(path, { force: true });
  }
}

/** Reverse one harness in place: overlay, unregister, then drop its manifest key. */
export async function uninstallFor(harness: string, manifest: Manifest, dryRun: boolean): Promise<void> {
  const record = manifest.harnesses[harness];
  if (record === undefined) {
    console.log(`  ${harness}: not present in manifest — skipping`);
    return;
  }

  console.log(`preemdeck uninstall — target: ${harness}`);
  console.log("  reversing overlay:");
  const [restored, removed] = reverseOverlay(record.overlay ?? [], dryRun);

  console.log("  unregistering:");
  const [pluginsDone, marketsDone] = await unregister(harness, record, dryRun);

  // Mutate the in-memory manifest; the rewrite happens once per run in main().
  if (dryRun) {
    console.log(`  (dry-run) would drop manifest key for ${harness}`);
  } else {
    delete manifest.harnesses[harness];
  }

  console.log(
    `  ${harness}: ${restored} restored, ${removed} removed, ` +
      `${pluginsDone} plugin(s) + ${marketsDone} marketplace(s) unregistered`,
  );
  console.log();
}

export async function main(argv: string[] = Bun.argv.slice(2), repoRoot: string = REPO_ROOT): Promise<number> {
  const args = parseUninstallArgs(argv);
  const manifest = loadManifestOrExit(repoRoot);

  const targets = args.harness !== null ? [args.harness] : Object.keys(manifest.harnesses);

  console.log(`preemdeck uninstall — harnesses: ${targets.join(", ")}`);
  if (args.dryRun) {
    console.log("  (dry-run — no changes will be made)");
  }
  console.log();

  for (const harness of targets) {
    await uninstallFor(harness, manifest, args.dryRun);
  }

  writeManifest(repoRoot, manifest, args.dryRun);

  if (args.purge) {
    console.log();
    console.log("To remove the preemdeck source dir (this script lives inside it), run manually:");
    console.log(`  rm -rf ${repoRoot}`);
  }

  console.log("Restart your CLI to drop the unregistered plugins.");
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
