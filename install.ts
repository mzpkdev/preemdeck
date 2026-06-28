#!/usr/bin/env bun
/**
 * install.ts — preemdeck installer (behavior-identical v1).
 *
 * Registers the marketplace (claude/codex) or installs per-extension (gemini) for
 * ONE harness, copies the per-harness overlay into the host config dir, and writes
 * the install manifest. Shell-outs spawn inline via `Bun.spawn(argv, PIPED)`
 * and reap through process.ts `reap` (the timeout/kill is solved there). Backups
 * use a .bak/.bak.<ts> scheme and the manifest is written at schema 1.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import argvex, { ArgvexError } from "argvex";
import { PIPED, type Reaped, reap } from "./source/common/process";

// Where preemdeck's source lives. Under the decoupled layout boot.sh clones to
// ~/.preemdeck, so import.meta.dir resolves there — distinct from any host config dir.
export const REPO_ROOT = import.meta.dir;

// Authoritative plugin source: ~/.preemdeck/source/ripperdoc/<rack>. Plugin CODE (.ts)
// executes from here by absolute path; the host plugin-cache copy carries ONLY
// harness-parsed primitives — never .ts — mirrored to STAGE_ROOT below.
//
// Primitives-only mirror: rebuilt from source/ripperdoc/ on every install (rm + recreate)
// at ~/.preemdeck/.stage/<rack>. Hosts register marketplaces from HERE, so their
// plugin cache holds manifests/SKILL.md/commands/hook decls but no executable code.
// Gitignored. See buildMirror()/stampMirror().
export const STAGE_ROOT = ".stage";

// Rack paths are absolute and rooted at the MIRROR (~/.preemdeck/.stage/<rack>).
// Plugins register/install by this absolute path, so the host's plugin cache points
// at the primitives-only mirror — the .ts source stays in source/ripperdoc/, nothing squatted.
export const MARKETPLACES: Array<[string, string]> = [
  ["chrome", join(REPO_ROOT, STAGE_ROOT, "chrome")],
  ["dock", join(REPO_ROOT, STAGE_ROOT, "dock")],
  ["drivers", join(REPO_ROOT, STAGE_ROOT, "drivers")],
  ["wetware", join(REPO_ROOT, STAGE_ROOT, "wetware")],
  ["firmware", join(REPO_ROOT, STAGE_ROOT, "firmware")],
];

// Host config dirs, relative to the user's home. configDir() resolves these
// cross-platform via os.homedir() — these are the overlay copy destinations.
export const CONFIG_DIRNAMES: Record<string, string> = { claude: ".claude", codex: ".codex", gemini: ".gemini" };

export const HOSTS = ["claude", "codex", "gemini"];
export const MARKETPLACE_HOSTS = new Set(["claude", "codex"]);

// Overlay source: `source/overwrite/<harness>/` is COPIED into configDir by copyOverlay().
// This tree is part of preemdeck's PERSISTENT source — it is read on every
// install/update and must survive (never cleaned up). See copyOverlay().
export const STAGING_ROOT = "source/overwrite";

// Install manifest: records what each install wrote (overlay files + their
// backups, registered marketplaces, installed plugins) so uninstall.ts
// can read it back. Lives at REPO_ROOT and is keyed + MERGED per harness.
export const MANIFEST_FILE = ".install-manifest.json";
export const MANIFEST_SCHEMA = 1;

// hardcoded skip — never install these, regardless of marketplace.json
export const DISABLED_PLUGINS: ReadonlySet<string> = new Set(["ghost"]);

// User-local config. preemdeck.json is gitignored per-install state (the directive
// object set-mode.ts writes); install.ts WRITES it from the built-in DEFAULT_CONFIG
// on first install, so user edits survive a re-install — git never tracks it (a
// re-clone can't revert it) and seedConfig never overwrites it. The defaults live
// here, not in a tracked file.
export const CONFIG_FILE = "preemdeck.json";
export const DEFAULT_CONFIG = `${JSON.stringify({ directive: { strategy: "swarm", discretion: "ask" } }, null, 2)}\n`;

export const CHECK = "✓";
export const CROSS = "✗";

export interface PluginSpec {
  name: string;
  sourcePath: string;
}

export interface OverlayRecord {
  dst: string;
  src: string;
  backup: string | null;
  action: "create" | "overwrite";
}

interface ManifestHarness {
  installed_at?: string;
  overlay?: OverlayRecord[];
  marketplaces?: string[];
  plugins?: Array<Record<string, unknown>>;
}

export interface Manifest {
  schema: number;
  harnesses: Record<string, ManifestHarness>;
}

export function manifestDir(host: string): string {
  return ({ claude: ".claude-plugin", codex: ".agents/plugins" } as Record<string, string>)[host] as string;
}

/**
 * Resolve the host's config dir (~/.claude, ~/.codex, ~/.gemini).
 *
 * Cross-platform: joins the dirname onto os.homedir() via node:path, no hardcoded
 * separators. This is the overlay copy destination — never preemdeck's source.
 */
export function configDir(harness: string): string {
  return join(homedir(), CONFIG_DIRNAMES[harness] as string);
}

/**
 * Read plugin specs from the rack's Claude marketplace.json (canonical source).
 *
 * Claude's schema has the simplest `source: "./path"` strings — Codex/Gemini installs
 * derive from the same list. A bucket with no Claude marketplace returns empty.
 */
export function readPluginSpecs(rackPath: string): PluginSpec[] {
  const manifest = join(rackPath, ".claude-plugin", "marketplace.json");
  if (!existsSync(manifest)) {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(manifest, "utf8"));
  } catch {
    return [];
  }
  const plugins = (data as { plugins?: unknown }).plugins;
  if (!Array.isArray(plugins)) {
    return [];
  }
  const specs: PluginSpec[] = [];
  for (const entry of plugins) {
    const name = (entry as { name?: unknown }).name;
    const source = (entry as { source?: unknown }).source;
    if (typeof name === "string" && typeof source === "string" && !DISABLED_PLUGINS.has(name)) {
      specs.push({ name, sourcePath: resolve(rackPath, source) });
    }
  }
  return specs;
}

// timeoutMs is injectable (default 10_000) so tests can drive the timeout path with
// a real fast-firing reap timer; the default keeps the "timed out after 10s"
// message on the production path (10_000 / 1000 = 10).
export async function runCli(cmd: string[], dryRun: boolean, timeoutMs = 10_000): Promise<[boolean, string]> {
  if (dryRun) {
    return [true, ""];
  }
  let result: Reaped;
  try {
    result = await reap(Bun.spawn(cmd, PIPED), timeoutMs);
  } catch (err) {
    // Bun.spawn throws (ENOENT) when cmd[0] is not on PATH, before reap ever sees
    // the child — reap does not swallow it. Treat a missing executable as not-found.
    if (isNotFound(err)) {
      return [false, `${cmd[0]} not on PATH`];
    }
    throw err;
  }
  if (result.timedOut) {
    return [false, `timed out after ${timeoutMs / 1000}s`];
  }
  if (result.exitCode === 0) {
    return [true, ""];
  }
  return [false, result.stderr.trim() || result.stdout.trim() || "non-zero exit"];
}

/** True when an error from Bun.spawn means the executable was not found. */
function isNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "ENOENT") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /ENOENT|not found|No such file/i.test(message);
}

export async function registerMarketplace(host: string, path: string, dryRun: boolean): Promise<[boolean, string]> {
  if (!MARKETPLACE_HOSTS.has(host)) {
    return [true, ""];
  }
  const [ok, err] = await runCli([host, "plugin", "marketplace", "add", path], dryRun);
  if (!ok && err.toLowerCase().includes("already")) {
    return [true, ""];
  }
  return [ok, err];
}

/**
 * Refresh a host's cached marketplace clone so local marketplace edits are seen.
 * Claude reads a cached clone to resolve plugins and does NOT re-fetch it on
 * install/update (claude-code#46081), so without this the cached plugin copy can go
 * stale. Best-effort — failure doesn't block the install.
 */
export async function refreshMarketplace(host: string, name: string, dryRun: boolean): Promise<[boolean, string]> {
  return runCli([host, "plugin", "marketplace", "update", name], dryRun);
}

export async function installPlugin(
  host: string,
  spec: PluginSpec,
  marketplace: string,
  dryRun: boolean,
): Promise<[boolean, string]> {
  if (host === "gemini") {
    return installGeminiExtension(spec, dryRun);
  }
  // Codex's install verb is `add`; Claude's is `install`.
  const verb = host === "codex" ? "add" : "install";
  const cmd = [host, "plugin", verb, `${spec.name}@${marketplace}`];
  if (host === "claude") {
    cmd.push("--scope", "user");
  }
  return runCli(cmd, dryRun);
}

/**
 * Install (or refresh) a Gemini extension from its local source. `install --path`
 * creates it on first run but no-ops once present — so on "already installed" fall
 * back to `extensions update <name>` to re-sync from the local source. Takes effect
 * next CLI start.
 */
async function installGeminiExtension(spec: PluginSpec, dryRun: boolean): Promise<[boolean, string]> {
  const [ok, err] = await runCli(["gemini", "extensions", "install", "--path", spec.sourcePath], dryRun);
  if (ok) {
    return [ok, err];
  }
  if (/already|exists/i.test(err)) {
    return runCli(["gemini", "extensions", "update", spec.name], dryRun);
  }
  return [ok, err];
}

/** Read the install manifest, returning an empty skeleton if absent/corrupt. */
export function loadManifest(repoRoot: string): Manifest {
  const path = join(repoRoot, MANIFEST_FILE);
  if (existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
      if (
        data !== null &&
        typeof data === "object" &&
        !Array.isArray(data) &&
        typeof (data as { harnesses?: unknown }).harnesses === "object" &&
        (data as { harnesses?: unknown }).harnesses !== null &&
        !Array.isArray((data as { harnesses?: unknown }).harnesses)
      ) {
        return data as Manifest;
      }
    } catch {
      // fall through to skeleton
    }
  }
  return { schema: MANIFEST_SCHEMA, harnesses: {} };
}

/**
 * Pick a backup path for dst, mirroring boot.sh's `.bak` → `.bak.<ts>` scheme.
 *
 * First clobber of a pre-existing file lands at `<dst>.bak`; if that already
 * exists, fall back to `<dst>.bak.<unix_ts>` so an earlier backup is never lost.
 */
export function backupPath(dst: string): string {
  const primary = `${dst}.bak`;
  if (!existsSync(primary)) {
    return primary;
  }
  return `${dst}.bak.${Math.floor(Date.now() / 1000)}`;
}

/** Recursively collect every regular file under `root` (absolute paths). */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/**
 * File-level ALLOWLIST for the primitives-only mirror. A rack-relative POSIX path
 * is copied iff it matches one of these — when unsure, EXCLUDE. The set is exactly
 * the host-parsed primitives: marketplaces, plugin manifests, codex hook decls,
 * gemini extension manifests, skills (SKILL.md) and command TOMLs. Everything else
 * (*.ts, directive.md, agents/openai.yaml, modes.json, README.md, *.dat, stock/*.md,
 * IMPRINT.md, hosts/*.md, toolbox/**, scripts/**) is left in source/ripperdoc/, never copied.
 */
export function isMirroredPrimitive(relPosix: string): boolean {
  return (
    relPosix.endsWith("/.claude-plugin/marketplace.json") ||
    relPosix.endsWith("/.claude-plugin/plugin.json") ||
    relPosix.endsWith("/.agents/plugins/marketplace.json") ||
    relPosix.endsWith("/.codex-plugin/plugin.json") ||
    relPosix.endsWith("/.codex-plugin/hooks/hooks.json") ||
    relPosix.endsWith("/gemini-extension.json") ||
    (relPosix.includes("/skills/") && relPosix.endsWith("/SKILL.md")) ||
    (relPosix.includes("/commands/") && relPosix.endsWith(".toml"))
  );
}

/** True when this JSON manifest carries a host-facing cache key we SHA-stamp. */
function isVersionedManifest(relPosix: string): boolean {
  return (
    relPosix.endsWith("/marketplace.json") ||
    relPosix.endsWith("/plugin.json") ||
    relPosix.endsWith("/gemini-extension.json")
  );
}

/**
 * Build the primitives-only mirror at `<repoRoot>/.stage/`.
 *
 * Rebuilt from scratch each run (rm + recreate) so a removed/renamed primitive
 * never lingers. For every rack under source/ripperdoc/, copy ONLY allowlisted files
 * (see isMirroredPrimitive) to `.stage/<rack>/<same-rel-path>`. The mirror is the
 * tree hosts register against — it must contain every manifest a host parses but
 * NO executable .ts. Skips the FS writes on a dry run (prints intent).
 *
 * Returns the absolute mirror paths written (rack-rel POSIX paths logged on dry-run).
 */
export function buildMirror(repoRoot: string, dryRun: boolean): string[] {
  const ripperdoc = join(repoRoot, "source", "ripperdoc");
  const stage = join(repoRoot, STAGE_ROOT);
  if (!existsSync(ripperdoc) || !statSync(ripperdoc).isDirectory()) {
    return [];
  }

  const written: string[] = [];
  if (dryRun) {
    for (const src of walkFiles(ripperdoc)) {
      const rel = relative(ripperdoc, src).split(sep).join("/");
      if (isMirroredPrimitive(`/${rel}`)) {
        written.push(join(stage, ...rel.split("/")));
      }
    }
    console.log(`  (dry-run) would mirror ${written.length} primitive(s) into ${STAGE_ROOT}/`);
    return written;
  }

  // Rebuild from scratch: a stale primitive must never survive a re-install.
  rmSync(stage, { recursive: true, force: true });
  for (const src of walkFiles(ripperdoc)) {
    const rel = relative(ripperdoc, src).split(sep).join("/");
    // Leading "/" anchors the suffix matchers to a rack-relative boundary.
    if (!isMirroredPrimitive(`/${rel}`)) {
      continue;
    }
    const dst = join(stage, ...rel.split("/"));
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    written.push(dst);
  }
  return written;
}

/**
 * Stamp every versioned manifest in the mirror with repoRoot's `git describe`
 * (the tag if HEAD is tagged — stable channel — else a short SHA — edge channel).
 *
 * Version is the host's plugin-cache key, so stamping it with the current describe
 * forces a re-copy whenever the source changes (replaces the deleted per-deploy
 * stamping). Resilient: if `git describe` fails (e.g. tmp dir is not a git repo),
 * leave versions unchanged and NEVER throw. Skips on a dry run.
 */
export async function stampMirror(repoRoot: string, mirrored: string[], dryRun: boolean): Promise<void> {
  if (dryRun) {
    return;
  }
  let sha = "";
  try {
    const r = await reap(Bun.spawn(["git", "-C", repoRoot, "describe", "--tags", "--always"], PIPED), 10_000);
    if (r.exitCode === 0) {
      sha = r.stdout.trim();
    }
  } catch {
    // not a git repo / git missing — leave versions unchanged
  }
  if (!sha) {
    return;
  }
  for (const path of mirrored) {
    const relPosix = `/${relative(join(repoRoot, STAGE_ROOT), path).split(sep).join("/")}`;
    if (!isVersionedManifest(relPosix)) {
      continue;
    }
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        continue;
      }
      let changed = false;
      // plugin.json / gemini-extension.json carry the cache key at the top level.
      if ("version" in data) {
        data.version = sha;
        changed = true;
      }
      // marketplace.json has NO top-level version — its per-plugin cache keys are
      // nested in plugins[].version, so stamp each entry too.
      if (Array.isArray(data.plugins)) {
        for (const entry of data.plugins) {
          if (entry !== null && typeof entry === "object" && "version" in entry) {
            entry.version = sha;
            changed = true;
          }
        }
      }
      if (changed) {
        writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
      }
    } catch {
      // unparseable / unwritable manifest — skip it, never abort the stamp
    }
  }
}

/**
 * Copy the per-harness overlay `source/overwrite/<harness>/*` into the host config dir.
 *
 * Hard-overwrite (no merging); backup-once before clobbering a genuinely
 * pre-existing user file (one with no prior manifest record) to `<dst>.bak` (or
 * `<dst>.bak.<ts>` if `.bak` is taken). Files we wrote on a prior run — already
 * recorded in this harness's overlay manifest — are NOT re-backed-up.
 *
 * Returns [ok, err, records] where each record is the overlay slice of the manifest.
 */
export function copyOverlay(
  harness: string,
  repoRoot: string,
  configDirPath: string,
  dryRun: boolean,
): [boolean, string, OverlayRecord[]] {
  const srcRoot = join(repoRoot, STAGING_ROOT, harness);
  if (!existsSync(srcRoot) || !statSync(srcRoot).isDirectory()) {
    // No overlay for this harness is fine — nothing to copy.
    return [true, "", []];
  }

  // Files we previously wrote for this harness must not be treated as
  // pre-existing user files, so we never back up our own output.
  const prior = loadManifest(repoRoot).harnesses[harness] ?? {};
  const ownWrites = new Set<string>();
  for (const rec of prior.overlay ?? []) {
    if (rec.dst) ownWrites.add(rec.dst);
  }

  const records: OverlayRecord[] = [];
  try {
    for (const src of walkFiles(srcRoot).sort()) {
      const rel = relative(srcRoot, src);
      const dst = join(configDirPath, rel);
      const dstAbs = dst;
      const existed = existsSync(dst);
      let backup: string | null = null;

      if (existed && !ownWrites.has(dstAbs)) {
        const bak = backupPath(dst);
        backup = bak;
        if (!dryRun) {
          copyFileSync(dst, bak);
        }
      }

      if (!dryRun) {
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, dst);
      }

      records.push({
        dst: dstAbs,
        src: relative(repoRoot, src),
        backup,
        action: existed ? "overwrite" : "create",
      });
    }
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc);
    return [false, `overlay copy failed: ${message}`, records];
  }

  return [true, "", records];
}

/**
 * Merge this install's record into the per-harness manifest at REPO_ROOT.
 *
 * Keyed by harness and MERGED: re-installing one harness leaves every other
 * harness's record intact. Skips the write on a dry run (prints intent).
 */
export function writeManifest(
  repoRoot: string,
  harness: string,
  overlay: OverlayRecord[],
  marketplaces: string[],
  plugins: Array<Record<string, unknown>>,
  dryRun: boolean,
): void {
  if (dryRun) {
    console.log(`  (dry-run) would record manifest for ${harness}: ${overlay.length} overlay file(s)`);
    return;
  }
  const manifest = loadManifest(repoRoot);
  manifest.schema = MANIFEST_SCHEMA;
  manifest.harnesses[harness] = {
    installed_at: new Date().toISOString().replace(/Z$/, "+00:00"),
    overlay,
    marketplaces,
    plugins,
  };
  writeFileSync(join(repoRoot, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Whether `bin` resolves on PATH (via `command -v`). */
async function onPath(bin: string): Promise<boolean> {
  const result = await reap(Bun.spawn(["sh", "-c", `command -v "$1" >/dev/null 2>&1`, "sh", bin], PIPED));
  return result.exitCode === 0;
}

export interface CliArgs {
  harness: string;
  dryRun: boolean;
}

export function parseInstallArgs(argv: string[]): CliArgs {
  const prog = "install.ts";
  let parsed: ReturnType<typeof argvex>;
  try {
    // strict: unknown options must be rejected (exit 2), as parseArgs did.
    parsed = argvex({ argv, schema: [{ name: "dry-run", arity: 0 }], strict: true });
  } catch (err) {
    process.stderr.write(`${prog}: ${err instanceof ArgvexError ? err.message : String(err)}\n`);
    process.exit(2);
  }
  const positionals = parsed._;
  if (positionals.length === 0) {
    process.stderr.write(`${prog}: the following arguments are required: harness\n`);
    process.exit(2);
  }
  const harness = positionals[0] as string;
  if (!HOSTS.includes(harness)) {
    process.stderr.write(`${prog}: argument harness: invalid choice: '${harness}' (choose from ${HOSTS.join(", ")})\n`);
    process.exit(2);
  }
  return { harness, dryRun: parsed["dry-run"] != null };
}

export function printSummary(harness: string, results: Record<string, string>): void {
  console.log();
  console.log("preemdeck install — done");
  console.log();
  const marks = MARKETPLACES.map(([name]) => `${results[name] === "ok" ? CHECK : CROSS} ${name}`);
  console.log(`  ${harness.padEnd(7)} ${marks.join("  ")}`);

  const errors: string[] = [];
  for (const [name] of MARKETPLACES) {
    const status = results[name] ?? "";
    if (status && status !== "ok") {
      errors.push(`  ${harness} / ${name}: ${status}`);
    }
  }
  if (errors.length > 0) {
    console.log();
    console.log("Errors:");
    for (const line of errors) {
      console.log(line);
    }
  }

  console.log();
  console.log("  Restart your CLI to load.");
  console.log();
}

/**
 * Write the user-local preemdeck.json from the built-in DEFAULT_CONFIG, if absent.
 *
 * preemdeck.json is gitignored (the directive object); the defaults live in this
 * install script, not a tracked file. Seed-if-absent: create it on first install, NEVER
 * overwrite an existing one — so set-mode.ts's writes persist across re-installs
 * (gitignored => a re-clone leaves it alone; this won't clobber it).
 */
export function seedConfig(repoRoot: string, dryRun: boolean): void {
  const dst = join(repoRoot, CONFIG_FILE);
  if (existsSync(dst)) {
    return;
  }
  if (dryRun) {
    console.log(`  (dry-run) would write ${CONFIG_FILE} with defaults`);
    return;
  }
  writeFileSync(dst, DEFAULT_CONFIG);
  console.log(`  ${CHECK} wrote ${CONFIG_FILE} (defaults)`);
}

export async function installFor(harness: string, dryRun: boolean): Promise<number> {
  if (!(await onPath(harness))) {
    process.stderr.write(`${harness} not on PATH. Install it and re-run.\n`);
    return 1;
  }

  console.log(`preemdeck install — target: ${harness}`);
  if (dryRun) {
    console.log("  (dry-run — no changes will be made)");
  }
  console.log();

  seedConfig(REPO_ROOT, dryRun);

  const [ok, err, overlay] = copyOverlay(harness, REPO_ROOT, configDir(harness), dryRun);
  if (!ok) {
    process.stderr.write(`  ${CROSS} overlay: ${err}\n`);
    return 1;
  }

  // Build the primitives-only mirror BEFORE registration: hosts register from
  // .stage/<rack>, and the SHA stamp is the cache key that forces a re-copy.
  const mirrored = buildMirror(REPO_ROOT, dryRun);
  await stampMirror(REPO_ROOT, mirrored, dryRun);

  const results: Record<string, string> = {};
  let anySuccess = false;
  const registeredMarketplaces: string[] = [];
  const installedPlugins: Array<Record<string, unknown>> = [];

  for (const [name, path] of MARKETPLACES) {
    const [mOk, mErr] = await registerMarketplace(harness, path, dryRun);
    if (mOk) {
      results[name] = "ok";
      anySuccess = true;
      if (MARKETPLACE_HOSTS.has(harness)) {
        registeredMarketplaces.push(name);
      }
      if (harness === "claude") {
        // Claude won't re-fetch the cached marketplace clone on install (claude-code#46081),
        // so local marketplace edits stay invisible until the clone is refreshed.
        await refreshMarketplace(harness, name, dryRun);
      }
      for (const spec of readPluginSpecs(path)) {
        const [pOk, pErr] = await installPlugin(harness, spec, name, dryRun);
        const lowered = pErr.toLowerCase();
        if (pOk || lowered.includes("already") || lowered.includes("exists")) {
          installedPlugins.push({ host: harness, rack: name, name: spec.name });
        } else {
          results[name] = `${spec.name}: ${pErr}`.slice(0, 60);
        }
      }
    } else {
      results[name] = mErr.slice(0, 60);
    }
  }

  printSummary(harness, results);
  writeManifest(REPO_ROOT, harness, overlay, registeredMarketplaces, installedPlugins, dryRun);
  return anySuccess ? 0 : 1;
}

export async function main(): Promise<number> {
  const args = parseInstallArgs(Bun.argv.slice(2));
  return installFor(args.harness, args.dryRun);
}

if (import.meta.main) {
  process.exit(await main());
}
