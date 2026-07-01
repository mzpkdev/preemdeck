#!/usr/bin/env bun
/**
 * install.ts — preemdeck installer (behavior-identical v1).
 *
 * Wears a ripperdoc install skin (ANSI banner + phased section()/sub() output), gated on a
 * real stdout TTY + NO_COLOR. It also installs its OWN node_modules as an early phase
 * (installDeps — relocated from boot.sh so the bun-install runs under the banner, not as
 * silent pre-handoff noise). To LOAD before those deps exist, install.ts keeps zero
 * third-party imports: its arg parse is hand-rolled, not argvex.
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
import type { Channel, Config } from "./src/common/preemdeck";
import { PIPED, type Reaped, reap } from "./src/common/process";

// Where preemdeck's source lives. Under the decoupled layout boot.sh clones to
// ~/.preemdeck, so import.meta.dir resolves there — distinct from any host config dir.
export const REPO_ROOT = import.meta.dir;

// Authoritative plugin source: ~/.preemdeck/src/ripperdoc/<rack>. Plugin CODE (.ts)
// executes from here by absolute path; the host plugin-cache copy carries ONLY
// harness-parsed primitives — never .ts — mirrored to STAGE_ROOT below.
//
// Primitives-only mirror: rebuilt from src/ripperdoc/ on every install (rm + recreate)
// at ~/.preemdeck/.stage/<rack>. Hosts register marketplaces from HERE, so their
// plugin cache holds manifests/SKILL.md/commands/hook decls but no executable code.
// Gitignored. See buildMirror()/stampMirror().
export const STAGE_ROOT = ".stage";

// Rack paths are absolute and rooted at the MIRROR (~/.preemdeck/.stage/<rack>).
// Plugins register/install by this absolute path, so the host's plugin cache points
// at the primitives-only mirror — the .ts source stays in src/ripperdoc/, nothing squatted.
export const MARKETPLACES: Array<[string, string]> = [
  ["chrome", join(REPO_ROOT, STAGE_ROOT, "chrome")],
  ["dock", join(REPO_ROOT, STAGE_ROOT, "dock")],
  ["wetware", join(REPO_ROOT, STAGE_ROOT, "wetware")],
  ["firmware", join(REPO_ROOT, STAGE_ROOT, "firmware")],
];

// Host config dirs, relative to the user's home. configDir() resolves these
// cross-platform via os.homedir() — these are the overlay copy destinations.
export const CONFIG_DIRNAMES: Record<string, string> = { claude: ".claude", codex: ".codex", gemini: ".gemini" };

export const HOSTS = ["claude", "codex", "gemini"];
export const MARKETPLACE_HOSTS = new Set(["claude", "codex"]);

// Overlay source: `src/overwrite/<harness>/` is COPIED into configDir by copyOverlay().
// This tree is part of preemdeck's PERSISTENT source — it is read on every
// install/update and must survive (never cleaned up). See copyOverlay().
export const STAGING_ROOT = "src/overwrite";

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
const DEFAULT_CONFIG_DATA: Config = {
  directive: { strategy: "swarm", discretion: "ask" },
  notify: { sound: true, turn: true, permission: true, ask: true, plan: true },
  interactive: false,
};
export const DEFAULT_CONFIG = `${JSON.stringify(DEFAULT_CONFIG_DATA, null, 2)}\n`;

export const CHECK = "✓";
export const CROSS = "✗";

// ── install UI (ripperdoc skin) ─────────────────────────
// ANSI palette gated on a real stdout TTY + NO_COLOR, so redirected installs and the test
// harness (which spies console.log) stay plain. The banner/typewriter ANIMATE only on a
// TTY; section()/sub() always emit (color auto-stripped) so a piped log still reads.
const IS_TTY = Boolean(process.stdout.isTTY);
// NO_COLOR (any value) hard-disables; FORCE_COLOR opts a non-TTY pipe back in. Animation
// stays TTY-only regardless — a redirected log gets color (if forced) but no typewriter.
const FORCE_COLOR = ["1", "true", "yes"].includes((process.env.FORCE_COLOR ?? "").toLowerCase());
const COLOR = !process.env.NO_COLOR && (IS_TTY || FORCE_COLOR);
const sgr = (code: string): string => (COLOR ? code : "");
const CYAN = sgr("\x1b[96m");
const RED = sgr("\x1b[91m");
const DIM = sgr("\x1b[2m");
const BOLD = sgr("\x1b[1m");
const WHITE = sgr("\x1b[97m");
const RESET = sgr("\x1b[0m");

// PREEMDECK in the ANSI Shadow figlet font — shares the "PREEM" prefix with preemclaud's
// rig banner; only D-E-C-K diverge. Trailing spaces on the K rows are intentional glyph fill.
const BANNER = `${CYAN}${BOLD}
    ██████╗ ██████╗ ███████╗███████╗███╗   ███╗██████╗ ███████╗ ██████╗██╗  ██╗
    ██╔══██╗██╔══██╗██╔════╝██╔════╝████╗ ████║██╔══██╗██╔════╝██╔════╝██║ ██╔╝
    ██████╔╝██████╔╝█████╗  █████╗  ██╔████╔██║██║  ██║█████╗  ██║     █████╔╝
    ██╔═══╝ ██╔══██╗██╔══╝  ██╔══╝  ██║╚██╔╝██║██║  ██║██╔══╝  ██║     ██╔═██╗
    ██║     ██║  ██║███████╗███████╗██║ ╚═╝ ██║██████╔╝███████╗╚██████╗██║  ██╗
    ╚═╝     ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝     ╚═╝╚═════╝ ╚══════╝ ╚═════╝╚═╝  ╚═╝
${RESET}${DIM}                  chrome for claude code · codex · gemini cli${RESET}`;

/** Phase header — `>>> label`. */
function section(label: string): void {
  console.log(`    ${DIM}>>>${RESET} ${BOLD}${label}${RESET}`);
}

/** Indented detail line under a section — `› msg`. */
function sub(msg: string): void {
  console.log(`        ${DIM}›${RESET} ${msg}`);
}

/** Typewriter a line to a TTY; plain print when not interactive (tests, pipes). */
async function typing(text: string, delay = 12): Promise<void> {
  if (!IS_TTY) {
    console.log(`    ${text}`);
    return;
  }
  process.stdout.write("    ");
  for (const ch of text) {
    process.stdout.write(ch);
    await Bun.sleep(delay);
  }
  process.stdout.write("\n");
}

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
 * Auto-detect which supported hosts are installed, by the presence of their config dir
 * under $HOME (~/.claude, ~/.codex, ~/.gemini). This is the selection signal when no
 * harness is named on the CLI: install targets exactly the detected set, in HOSTS order.
 *
 * `resolve` is injectable for tests — configDir() joins os.homedir(), which Bun snapshots
 * at process start (a runtime $HOME mutation is NOT observable), so a fake home can only
 * be threaded in here, not via env. A name whose path is absent OR is a non-directory
 * (a stray file) does not count as installed.
 */
export function detectHarnesses(resolve: (harness: string) => string = configDir): string[] {
  return HOSTS.filter((harness) => {
    try {
      return statSync(resolve(harness)).isDirectory();
    } catch {
      return false;
    }
  });
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
 * Install (or refresh) a Gemini extension from its local source. The source is a
 * POSITIONAL — `extensions install <path>` (there is no `--path` flag on 0.49). `--consent`
 * skips the security confirmation prompt (required for a non-interactive install) and
 * `--skip-settings` skips the on-install configuration step. The install creates the
 * extension on first run but no-ops once present — so on "already installed" fall back to
 * `extensions update <name>` to re-sync from the local source. Takes effect next CLI start.
 */
async function installGeminiExtension(spec: PluginSpec, dryRun: boolean): Promise<[boolean, string]> {
  const cmd = ["gemini", "extensions", "install", spec.sourcePath, "--consent", "--skip-settings"];
  const [ok, err] = await runCli(cmd, dryRun);
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
 * IMPRINT.md, hosts/*.md, toolbox/**, scripts/**) is left in src/ripperdoc/, never copied.
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
 * never lingers. For every rack under src/ripperdoc/, copy ONLY allowlisted files
 * (see isMirroredPrimitive) to `.stage/<rack>/<same-rel-path>`. The mirror is the
 * tree hosts register against — it must contain every manifest a host parses but
 * NO executable .ts. Skips the FS writes on a dry run (prints intent).
 *
 * Returns the absolute mirror paths written (rack-rel POSIX paths logged on dry-run).
 */
export function buildMirror(repoRoot: string, dryRun: boolean): string[] {
  const ripperdoc = join(repoRoot, "src", "ripperdoc");
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
    // Caller (installFor) reports the count under its phase; stay silent to avoid a
    // duplicate, un-indented line in the dry-run render.
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
 * Copy the per-harness overlay `src/overwrite/<harness>/*` into the host config dir.
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
    sub(`${DIM}would record manifest: ${overlay.length} overlay file(s)${RESET}`);
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
  // Explicit harness targets parsed from argv. EMPTY selects auto-detect — main() then
  // installs to every host detected via detectHarnesses().
  harnesses: string[];
  dryRun: boolean;
}

export function parseInstallArgs(argv: string[]): CliArgs {
  // Hand-rolled (no argvex) ON PURPOSE: install.ts installs its own node_modules (see
  // installDeps), so it must LOAD with zero third-party imports — it can't depend on a
  // package it hasn't installed yet. The parse is trivial: 0..N positionals + one flag.
  // Zero positionals is NOT an error — it selects auto-detect (main reads detectHarnesses()).
  const prog = "install.ts";
  const positionals: string[] = [];
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("-")) {
      process.stderr.write(`${prog}: unrecognized option: ${arg}\n`);
      process.exit(2);
    } else {
      positionals.push(arg);
    }
  }
  for (const harness of positionals) {
    if (!HOSTS.includes(harness)) {
      process.stderr.write(
        `${prog}: argument harness: invalid choice: '${harness}' (choose from ${HOSTS.join(", ")})\n`,
      );
      process.exit(2);
    }
  }
  return { harnesses: positionals, dryRun };
}

export function printSummary(harness: string, results: Record<string, string>): void {
  const errors: string[] = [];
  for (const [name] of MARKETPLACES) {
    const status = results[name] ?? "";
    if (status && status !== "ok") {
      errors.push(`${harness} / ${name}: ${status}`);
    }
  }

  console.log();
  const marks = MARKETPLACES.map(([name]) => {
    const ok = results[name] === "ok";
    return `${ok ? CYAN + CHECK : RED + CROSS}${RESET} ${name}`;
  });
  console.log(`    ${DIM}rig${RESET}  ${harness.padEnd(7)}${marks.join("   ")}`);

  // Per-harness errors surface here, next to their rig. The pass/fail banner + restart
  // hint print ONCE at the end of main() across every target — not per rig.
  if (errors.length > 0) {
    console.log();
    for (const line of errors) {
      console.log(`    ${RED}${CROSS}${RESET} ${line}`);
    }
  }
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
    sub(`${CONFIG_FILE} ${DIM}present${RESET}`);
    return;
  }
  if (dryRun) {
    sub(`${DIM}would seed ${CONFIG_FILE} with defaults${RESET}`);
    return;
  }
  writeFileSync(dst, DEFAULT_CONFIG);
  sub(`${CONFIG_FILE} ${DIM}seeded with defaults${RESET}`);
}

/**
 * Persist the resolved release channel into preemdeck.json (read-modify-write, so the
 * user's `directive` survives). boot.sh fetched the channel named by PREEMDECK_CHANNEL
 * (its own default is stable), so install.ts mirrors that env here; update.ts reads it
 * back and forwards it, keeping `update` on the channel you installed with.
 *
 * Unlike seedConfig this writes on EVERY install — a channel SWITCH (edge→stable on a
 * later run) must overwrite the recorded value, which seed-if-absent never would.
 */
export function recordChannel(repoRoot: string, dryRun: boolean): void {
  const channel: Channel = process.env.PREEMDECK_CHANNEL === "edge" ? "edge" : "stable";
  if (dryRun) {
    sub(`${DIM}would record channel ${channel}${RESET}`);
    return;
  }
  const dst = join(repoRoot, CONFIG_FILE);
  let data: Config = {};
  if (existsSync(dst)) {
    try {
      data = JSON.parse(readFileSync(dst, "utf8")) as Config;
    } catch {
      data = {}; // unparseable — seedConfig owns directive recovery; we just (re)set channel
    }
  }
  data.channel = channel;
  writeFileSync(dst, `${JSON.stringify(data, null, 2)}\n`);
  sub(`channel ${DIM}${channel}${RESET}`);
}

/**
 * Install preemdeck's runtime deps (hono, zod, cmdore, …) into node_modules so deployed
 * plugin code can execute from ~/.preemdeck by absolute path. Runs `<bun> install
 * --production` on the SAME Bun executing install.ts (process.execPath — the vendored
 * runtime under preemdeck-runtime), in repoRoot.
 *
 * Relocated from boot.sh so it renders as an install phase under the banner. Best-effort by
 * contract: a failure is REPORTED but never aborts the install (node_modules is gitignored —
 * a fresh clone has none until this runs; a stale clone keeps its last good set). Skips the
 * spawn on a dry run.
 */
export async function installDeps(repoRoot: string, dryRun: boolean): Promise<[boolean, string]> {
  if (dryRun) {
    return [true, ""];
  }
  let result: Reaped;
  try {
    result = await reap(Bun.spawn([process.execPath, "install", "--production"], { ...PIPED, cwd: repoRoot }), 300_000);
  } catch (err) {
    return [false, err instanceof Error ? err.message : String(err)];
  }
  if (result.timedOut) {
    return [false, "timed out after 300s"];
  }
  if (result.exitCode === 0) {
    return [true, ""];
  }
  return [false, result.stderr.trim() || result.stdout.trim() || "non-zero exit"];
}

export async function installFor(harness: string, dryRun: boolean): Promise<number> {
  section(`rig · ${harness}`);
  if (!(await onPath(harness))) {
    process.stderr.write(`${harness} not on PATH. Install it and re-run.\n`);
    console.log(`    ${RED}${BOLD}ABORT${RESET}  ${harness} ${DIM}not on PATH — install it and re-run.${RESET}`);
    return 1;
  }
  sub(`${harness.padEnd(7)} ${DIM}jacked in${RESET}`);
  console.log();

  section("grafting the overlay");
  const [ok, err, overlay] = copyOverlay(harness, REPO_ROOT, configDir(harness), dryRun);
  if (!ok) {
    process.stderr.write(`  ${CROSS} overlay: ${err}\n`);
    console.log(`    ${RED}${BOLD}ABORT${RESET}  overlay: ${err}`);
    return 1;
  }
  sub(`${overlay.length} file(s) ${DIM}→ ${configDir(harness)}${RESET}`);
  console.log();

  section("slotting chrome");
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
      const slotted: string[] = [];
      for (const spec of readPluginSpecs(path)) {
        const [pOk, pErr] = await installPlugin(harness, spec, name, dryRun);
        const lowered = pErr.toLowerCase();
        if (pOk || lowered.includes("already") || lowered.includes("exists")) {
          installedPlugins.push({ host: harness, rack: name, name: spec.name });
          slotted.push(spec.name);
        } else {
          results[name] = `${spec.name}: ${pErr}`.slice(0, 60);
        }
      }
      const mark = results[name] === "ok" ? `${CYAN}${CHECK}${RESET}` : `${RED}${CROSS}${RESET}`;
      sub(`${mark} ${name.padEnd(9)}${DIM}${slotted.join(" · ") || "—"}${RESET}`);
    } else {
      results[name] = mErr.slice(0, 60);
      sub(`${RED}${CROSS}${RESET} ${name.padEnd(9)}${RED}${mErr}${RESET}`);
    }
  }

  printSummary(harness, results);
  writeManifest(REPO_ROOT, harness, overlay, registeredMarketplaces, installedPlugins, dryRun);
  return anySuccess ? 0 : 1;
}

export async function main(): Promise<number> {
  const args = parseInstallArgs(Bun.argv.slice(2));
  console.log(BANNER);
  if (IS_TTY) {
    await Bun.sleep(300);
  }
  await typing("jacking in…", 20);
  console.log();

  // Named harness(es) override; with none, install to every host detected by config dir.
  const targets = args.harnesses.length > 0 ? args.harnesses : detectHarnesses();
  if (targets.length === 0) {
    process.stderr.write(
      "No supported harness detected — looked for ~/.claude, ~/.codex, ~/.gemini. Install one and re-run.\n",
    );
    console.log(
      `    ${RED}${BOLD}ABORT${RESET}  no harness detected ${DIM}— looked for ~/.claude · ~/.codex · ~/.gemini${RESET}`,
    );
    console.log();
    return 1;
  }

  // Harness-independent groundwork — runs ONCE no matter how many hosts we target.
  section("preflight");
  sub(`targets  ${DIM}${targets.join(" · ")}${RESET}`);
  if (args.dryRun) {
    sub(`${DIM}dry run — no changes will be written${RESET}`);
  }
  seedConfig(REPO_ROOT, args.dryRun);
  recordChannel(REPO_ROOT, args.dryRun);
  console.log();

  section("wiring runtime deps");
  const [depsOk, depsErr] = await installDeps(REPO_ROOT, args.dryRun);
  if (depsOk) {
    sub(args.dryRun ? `${DIM}would install runtime deps${RESET}` : `runtime deps ${DIM}ready${RESET}`);
  } else {
    sub(`${RED}${CROSS}${RESET} ${DIM}${depsErr.slice(0, 60)}${RESET}`);
    sub(`${DIM}plugins may miss deps — re-run boot.sh to retry${RESET}`);
  }
  console.log();

  // Build the primitives-only mirror BEFORE registration: hosts register from
  // .stage/<rack>, and the SHA stamp is the cache key that forces a re-copy.
  section("minting the mirror");
  const mirrored = buildMirror(REPO_ROOT, args.dryRun);
  await stampMirror(REPO_ROOT, mirrored, args.dryRun);
  sub(`${mirrored.length} primitive(s) ${DIM}→ ${STAGE_ROOT}/${RESET}`);
  console.log();

  // One host failing (not on PATH, marketplace error) is isolated — others still install,
  // and the run reports nonzero so boot.sh's `set -e` surfaces it.
  let rc = 0;
  const chromed: string[] = [];
  for (const harness of targets) {
    if ((await installFor(harness, args.dryRun)) === 0) {
      chromed.push(harness);
    } else {
      rc = 1;
    }
  }

  // Closing banner — printed ONCE for the whole run, not per rig. Lists every harness
  // that slotted clean so a single restart hint covers them all.
  if (rc === 0) {
    console.log(`    ${CYAN}${BOLD}━━━${RESET} ${WHITE}${BOLD}preem, choom. you're chromed.${RESET}`);
    console.log(`        ${DIM}restart ${chromed.join(" · ")} to load the new rig.${RESET}`);
  } else {
    console.log(`    ${RED}${BOLD}flatlined${RESET} ${DIM}— some racks didn't slot; see above.${RESET}`);
    if (chromed.length > 0) {
      console.log(`        ${DIM}restart ${chromed.join(" · ")} to load the new rig.${RESET}`);
    }
  }
  console.log();
  return rc;
}

if (import.meta.main) {
  process.exit(await main());
}
