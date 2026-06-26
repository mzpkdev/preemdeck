#!/usr/bin/env bun
/**
 * update.ts — preemdeck updater.
 *
 * Reads preemdeck.json's `version` to decide what to sync to (a channel branch, a
 * pinned tag, or the current branch), brings ~/.preemdeck to it, then re-runs the
 * install for every harness recorded in the manifest. Manifest-driven: the decoupled
 * layout means the harness can't be inferred from the directory name.
 */

import { join } from "node:path";
import { parseArgs } from "node:util";
import { _internals, CONFIG_FILE, installFor, loadManifest, MANIFEST_FILE, MANIFEST_SCHEMA } from "./install.ts";
import { readJson } from "./lib/json-store.ts";

// uses install's REPO_ROOT semantics, but resolved at THIS module's location so a
// standalone `bun update.ts` finds the manifest next to itself (same as install).
export const REPO_ROOT = import.meta.dir;

export interface UpdateArgs {
  dryRun: boolean;
}

export function parseUpdateArgs(argv: string[]): UpdateArgs {
  const prog = "update.ts";
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
    console.log(`  (dry-run) would run: git -C ${repoRoot} fetch --depth 1 origin && git reset --hard @{u}`);
    return;
  }
  // The dist branches are re-orphaned on every publish (force-pushed single commits), so a
  // fast-forward pull can't follow them. Fetch the tracked upstream and hard-reset onto it —
  // ~/.preemdeck is a managed clone with no local work to preserve (mirrors boot.sh reinstall).
  await runGit(repoRoot, ["fetch", "--depth", "1", "origin"]);
  await runGit(repoRoot, ["reset", "--hard", "@{u}"]);
}

// Channel name -> orphan dist branch (mirrors boot.sh's PREEMDECK_CHANNEL mapping).
export const CHANNELS: Record<string, string> = { stable: "dist-stable", edge: "dist-edge" };

export interface UpdateTarget {
  mode: "current" | "track" | "pin";
  ref: string;
  label: string;
}

/**
 * Resolve preemdeck.json's `version` to a git target:
 *   "stable" | "edge"   -> track the dist-<channel> branch (moving; fetch + checkout -B)
 *   "2.2.1" | "v2.2.1"  -> pin the v2.2.1 tag (frozen; detached checkout, no auto-advance)
 *   any other non-empty -> track it as a raw branch/ref
 *   absent / empty      -> "current": fast-forward whatever branch is checked out
 */
export function resolveTarget(version: string | undefined): UpdateTarget {
  const v = version?.trim();
  if (!v) {
    return { mode: "current", ref: "", label: "current branch" };
  }
  const channel = CHANNELS[v];
  if (channel) {
    return { mode: "track", ref: channel, label: `${v} (${channel})` };
  }
  if (/^v?\d+\.\d+\.\d+/.test(v)) {
    const tag = v.startsWith("v") ? v : `v${v}`;
    return { mode: "pin", ref: tag, label: `pinned ${tag}` };
  }
  return { mode: "track", ref: v, label: `branch ${v}` };
}

/** Read the `version` string from the user's preemdeck.json (undefined if unset). */
export async function readVersion(repoRoot: string): Promise<string | undefined> {
  const cfg = await readJson<{ version?: unknown }>(join(repoRoot, CONFIG_FILE), {});
  return typeof cfg.version === "string" ? cfg.version : undefined;
}

/**
 * Pick the version spec: the PREEMDECK_CHANNEL env var (the same knob boot.sh uses at
 * install) overrides preemdeck.json's `version`; a blank/unset env falls through to it.
 */
export function pickVersion(env: string | undefined, configVersion: string | undefined): string | undefined {
  const e = env?.trim();
  return e ? e : configVersion;
}

/** Run a git subcommand in repoRoot, streaming output; throw on non-zero (check=True). */
async function runGit(repoRoot: string, args: string[]): Promise<void> {
  const result = await _internals.spawn(["git", "-C", repoRoot, ...args]);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${result.exitCode})`);
  }
}

/**
 * Bring repoRoot to `target`. "current" fast-forwards the checked-out branch (status
 * quo). "track" fetches the branch into its remote-tracking ref and `checkout -B`s onto
 * it — a clean switch that sets upstream, so a later bare pull follows it and an
 * unrelated-orphan channel swap can't desync. "pin" fetches the tag and detaches onto it
 * (frozen). A dirty working tree makes checkout refuse — fail loud, never silently reset.
 */
export async function syncTo(repoRoot: string, target: UpdateTarget, dryRun: boolean): Promise<void> {
  if (target.mode === "current") {
    await gitPull(repoRoot, dryRun);
    return;
  }
  if (dryRun) {
    console.log(`  (dry-run) would sync to ${target.label}`);
    return;
  }
  if (target.mode === "track") {
    // boot.sh's `--branch` clone is single-branch, so other channels aren't fetchable
    // and checkout -B can't set upstream. Widen the refspec (idempotent) so origin/<branch>
    // is a real remote-tracking branch — then checkout -B sets upstream and a later bare
    // pull follows it, and an unrelated-orphan channel swap lands cleanly.
    await runGit(repoRoot, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    await runGit(repoRoot, ["fetch", "--depth", "1", "origin", target.ref]);
    await runGit(repoRoot, ["checkout", "-B", target.ref, `origin/${target.ref}`]);
    return;
  }
  await runGit(repoRoot, ["fetch", "--depth", "1", "origin", "tag", target.ref]);
  await runGit(repoRoot, ["checkout", target.ref]);
}

export async function main(): Promise<number> {
  const args = parseUpdateArgs(Bun.argv.slice(2));
  const harnesses = installedHarnesses();
  const target = resolveTarget(pickVersion(process.env.PREEMDECK_CHANNEL, await readVersion(REPO_ROOT)));

  console.log(`preemdeck update — harnesses: ${harnesses.join(", ")} — tracking: ${target.label}`);
  if (args.dryRun) {
    console.log("  (dry-run — no changes will be made)");
  }
  console.log();

  await syncTo(REPO_ROOT, target, args.dryRun);

  let exitCode = 0;
  for (const harness of harnesses) {
    exitCode |= await installFor(harness, args.dryRun);
  }
  return exitCode;
}

if (import.meta.main) {
  process.exit(await main());
}
