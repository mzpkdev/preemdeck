/**
 * hosts.ts — the host-CLI adapter: probe/detect harnesses and drive their plugin CLIs.
 *
 * Every shell-out spawns inline via `Bun.spawn(argv, PIPED)` and reaps through
 * process.ts `reap` (the timeout/kill is solved there). Dep-free: only node:*, Bun
 * globals, and ../common/process — safe for the pre-node_modules install/update graph.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { PIPED, type Reaped, reap } from "../common/process"
import { CONFIG_DIRNAMES, DISABLED_PLUGINS, HOSTS, MARKETPLACE_HOSTS } from "./constants"

export interface PluginSpec {
    name: string
    sourcePath: string
}

export function manifestDir(host: string): string {
    return ({ claude: ".claude-plugin", codex: ".agents/plugins" } as Record<string, string>)[host] as string
}

/**
 * Resolve the host's config dir (~/.claude, ~/.codex, ~/.gemini).
 *
 * Cross-platform: joins the dirname onto os.homedir() via node:path, no hardcoded
 * separators. This is the overlay copy destination — never preemdeck's source.
 */
export function configDir(harness: string): string {
    return join(homedir(), CONFIG_DIRNAMES[harness] as string)
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
            return statSync(resolve(harness)).isDirectory()
        } catch {
            return false
        }
    })
}

/**
 * Read plugin specs from the rack's Claude marketplace.json (canonical source).
 *
 * Claude's schema has the simplest `source: "./path"` strings — Codex/Gemini installs
 * derive from the same list. A bucket with no Claude marketplace returns empty.
 */
export function readPluginSpecs(rackPath: string): PluginSpec[] {
    const manifest = join(rackPath, ".claude-plugin", "marketplace.json")
    if (!existsSync(manifest)) {
        return []
    }
    let data: unknown
    try {
        data = JSON.parse(readFileSync(manifest, "utf8"))
    } catch {
        return []
    }
    const plugins = (data as { plugins?: unknown }).plugins
    if (!Array.isArray(plugins)) {
        return []
    }
    const specs: PluginSpec[] = []
    for (const entry of plugins) {
        const name = (entry as { name?: unknown }).name
        const source = (entry as { source?: unknown }).source
        if (typeof name === "string" && typeof source === "string" && !DISABLED_PLUGINS.has(name)) {
            specs.push({ name, sourcePath: resolve(rackPath, source) })
        }
    }
    return specs
}

// timeoutMs is injectable (default 10_000) so tests can drive the timeout path with
// a real fast-firing reap timer; the default keeps the "timed out after 10s"
// message on the production path (10_000 / 1000 = 10).
export async function runCli(cmd: string[], dryRun: boolean, timeoutMs = 10_000): Promise<[boolean, string]> {
    if (dryRun) {
        return [true, ""]
    }
    let result: Reaped
    try {
        result = await reap(Bun.spawn(cmd, PIPED), timeoutMs)
    } catch (err) {
        // Bun.spawn throws (ENOENT) when cmd[0] is not on PATH, before reap ever sees
        // the child — reap does not swallow it. Treat a missing executable as not-found.
        if (isNotFound(err)) {
            return [false, `${cmd[0]} not on PATH`]
        }
        throw err
    }
    if (result.timedOut) {
        // reap now returns the output captured before the kill — surface it so a
        // slow-but-working CLI (vs. a hung one) is tellable from the error alone.
        const tail = (result.stderr.trim() || result.stdout.trim()).slice(0, 80)
        return [false, `timed out after ${timeoutMs / 1000}s${tail ? ` — ${tail}` : ""}`]
    }
    if (result.exitCode === 0) {
        return [true, ""]
    }
    return [false, result.stderr.trim() || result.stdout.trim() || "non-zero exit"]
}

/** True when an error from Bun.spawn means the executable was not found. */
function isNotFound(err: unknown): boolean {
    const code = (err as { code?: unknown } | null)?.code
    if (code === "ENOENT") return true
    const message = err instanceof Error ? err.message : String(err)
    return /ENOENT|not found|No such file/i.test(message)
}

export async function registerMarketplace(host: string, path: string, dryRun: boolean): Promise<[boolean, string]> {
    if (!MARKETPLACE_HOSTS.has(host)) {
        return [true, ""]
    }
    const [ok, err] = await runCli([host, "plugin", "marketplace", "add", path], dryRun)
    if (!ok && err.toLowerCase().includes("already")) {
        return [true, ""]
    }
    return [ok, err]
}

/**
 * Refresh a host's cached marketplace clone so local marketplace edits are seen.
 * Claude reads a cached clone to resolve plugins and does NOT re-fetch it on
 * install/update (claude-code#46081), so without this the cached plugin copy can go
 * stale. Best-effort — failure doesn't block the install.
 */
export async function refreshMarketplace(host: string, name: string, dryRun: boolean): Promise<[boolean, string]> {
    return runCli([host, "plugin", "marketplace", "update", name], dryRun)
}

export async function installPlugin(
    host: string,
    spec: PluginSpec,
    marketplace: string,
    dryRun: boolean
): Promise<[boolean, string]> {
    if (host === "gemini") {
        return installGeminiExtension(spec, dryRun)
    }
    // Codex's install verb is `add`; Claude's is `install`.
    const verb = host === "codex" ? "add" : "install"
    const cmd = [host, "plugin", verb, `${spec.name}@${marketplace}`]
    if (host === "claude") {
        cmd.push("--scope", "user")
    }
    return runCli(cmd, dryRun)
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
    const cmd = ["gemini", "extensions", "install", spec.sourcePath, "--consent", "--skip-settings"]
    const [ok, err] = await runCli(cmd, dryRun)
    if (ok) {
        return [ok, err]
    }
    if (/already|exists/i.test(err)) {
        return runCli(["gemini", "extensions", "update", spec.name], dryRun)
    }
    return [ok, err]
}

/** Whether `bin` resolves on PATH (via `command -v`). */
export async function onPath(bin: string): Promise<boolean> {
    const result = await reap(Bun.spawn(["sh", "-c", `command -v "$1" >/dev/null 2>&1`, "sh", bin], PIPED))
    return result.exitCode === 0
}
