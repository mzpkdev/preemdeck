/**
 * constants.ts — dep-free install/uninstall/update constants.
 *
 * Every value here is a plain string/number/set or a pure function of `repoRoot`; no
 * module-global REPO_ROOT lives under src/install (the entry threads its own
 * import.meta.dir down), so the one path-derived value — `marketplaces` — takes repoRoot.
 */

import { join } from "node:path"
import type { Config } from "../common/preemdeck"

export const HOSTS = ["claude", "codex", "gemini"]
export const MARKETPLACE_HOSTS = new Set(["claude", "codex"])

// Host config dirs, relative to the user's home. configDir() resolves these
// cross-platform via os.homedir() — these are the overlay copy destinations.
export const CONFIG_DIRNAMES: Record<string, string> = { claude: ".claude", codex: ".codex", gemini: ".gemini" }

// Primitives-only mirror root: rebuilt from src/ripperdoc/ on every install (rm + recreate)
// at ~/.preemdeck/.stage/<rack>. Hosts register marketplaces from HERE, so their plugin
// cache holds manifests/SKILL.md/commands/hook decls but no executable code. Gitignored.
export const STAGE_ROOT = ".stage"

// Overlay source: `src/overwrite/<harness>/` is COPIED into configDir by copyOverlay().
// This tree is part of preemdeck's PERSISTENT source — read on every install/update and
// must survive (never cleaned up). See copyOverlay().
export const STAGING_ROOT = "src/overwrite"

// Install manifest: records what each install wrote (overlay files + their backups,
// registered marketplaces, installed plugins) so uninstall.ts can read it back. Lives at
// REPO_ROOT and is keyed + MERGED per harness.
export const MANIFEST_FILE = ".install-manifest.json"
export const MANIFEST_SCHEMA = 1

// hardcoded skip — never install these, regardless of marketplace.json
export const DISABLED_PLUGINS: ReadonlySet<string> = new Set(["ghost"])

// User-local config. preemdeck.json is gitignored per-install state (the directive
// object set-mode.ts writes); install.ts WRITES it from the built-in DEFAULT_CONFIG
// on first install, so user edits survive a re-install — git never tracks it (a
// re-clone can't revert it) and seedConfig never overwrites it. The defaults live
// here, not in a tracked file.
export const CONFIG_FILE = "preemdeck.json"
const DEFAULT_CONFIG_DATA: Config = {
    directive: { strategy: "swarm", discretion: "ask" },
    notify: { sound: true, turn: true, permission: true, ask: true, plan: true, broadcast: true },
    env: { HOLO_PLANNER: false }
}
export const DEFAULT_CONFIG = `${JSON.stringify(DEFAULT_CONFIG_DATA, null, 2)}\n`

// Rack names, in install order. printSummary renders per-rack marks from this list.
export const RACKS = ["chrome", "dock", "wetware", "firmware"]

/**
 * Rack marketplaces as [name, absolutePath] pairs, rooted at the MIRROR
 * (`<repoRoot>/.stage/<rack>`). Plugins register/install by this absolute path, so the
 * host's plugin cache points at the primitives-only mirror — the .ts source stays in
 * src/ripperdoc/, nothing squatted. Derives from repoRoot (the entry's import.meta.dir).
 */
export function marketplaces(repoRoot: string): Array<[string, string]> {
    return RACKS.map((rack): [string, string] => [rack, join(repoRoot, STAGE_ROOT, rack)])
}
