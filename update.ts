#!/usr/bin/env bun
/**
 * update.ts — preemdeck updater (TS port of update.py, behavior-identical v1).
 *
 * Pulls the latest source (git -C ~/.preemdeck pull --ff-only) and re-runs the
 * install for every harness recorded in the manifest. Manifest-driven: the
 * decoupled layout means the harness can't be inferred from the directory name.
 * Additive port — update.py stays the live entrypoint until the flip phase.
 */

import { join } from "node:path";
import { parseArgs } from "node:util";
import { _internals, installFor, loadManifest, MANIFEST_FILE, MANIFEST_SCHEMA } from "./install.ts";

// uses install's REPO_ROOT semantics, but resolved at THIS module's location so a
// standalone `bun update.ts` finds the manifest next to itself (same as install).
export const REPO_ROOT = import.meta.dir;

export interface UpdateArgs {
  dryRun: boolean;
}

export function parseUpdateArgs(argv: string[]): UpdateArgs {
  const prog = "update.py";
  try {
    const parsed = parseArgs({ args: argv, options: { "dry-run": { type: "boolean" } }, allowPositionals: true });
    return { dryRun: parsed.values["dry-run"] === true };
  } catch (err) {
    process.stderr.write(`${prog}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}

/**
 * Read installed harnesses from the manifest at REPO_ROOT.
 *
 * loadManifest() returns an empty skeleton on a missing or corrupt file, so guard
 * for both that and a schema mismatch here and bail with a friendly message
 * pointing back at boot.sh.
 */
export function installedHarnesses(repoRoot: string = REPO_ROOT): string[] {
  const manifest = loadManifest(repoRoot);
  const harnesses = manifest.harnesses ?? {};
  if (manifest.schema !== MANIFEST_SCHEMA || Object.keys(harnesses).length === 0) {
    process.stderr.write(`no install manifest at ${join(repoRoot, MANIFEST_FILE)} — run boot.sh first\n`);
    process.exit(1);
  }
  return Object.keys(harnesses);
}

export async function gitPull(repoRoot: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(`  (dry-run) would run: git -C ${repoRoot} pull --ff-only`);
    return;
  }
  const result = await _internals.spawn(["git", "-C", repoRoot, "pull", "--ff-only"]);
  // Stream child output through (subprocess.run with check=True inherits stdio in
  // Python; here we forward captured streams, then raise on non-zero like check=True).
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.exitCode !== 0) {
    throw new Error(`git pull --ff-only failed (exit ${result.exitCode})`);
  }
}

export async function main(): Promise<number> {
  const args = parseUpdateArgs(Bun.argv.slice(2));
  const harnesses = installedHarnesses();

  console.log(`preemdeck update — harnesses: ${harnesses.join(", ")}`);
  if (args.dryRun) {
    console.log("  (dry-run — no changes will be made)");
  }
  console.log();

  await gitPull(REPO_ROOT, args.dryRun);

  let exitCode = 0;
  for (const harness of harnesses) {
    exitCode |= await installFor(harness, args.dryRun);
  }
  return exitCode;
}

if (import.meta.main) {
  process.exit(await main());
}
