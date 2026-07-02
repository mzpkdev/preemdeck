/**
 * mirror.ts — the primitives-only mirror at `<repoRoot>/.stage/`.
 *
 * Hosts register marketplaces from the mirror, so it must carry every manifest a host
 * parses (marketplaces, plugin manifests, hook decls, SKILL.md, command TOMLs) but NO
 * executable .ts. Rebuilt from scratch each install; every versioned manifest is stamped
 * with `git describe` (the host plugin-cache key) so a source change forces a re-copy.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import { PIPED, reap } from "../common/process"
import { STAGE_ROOT } from "./constants"
import { walkFiles } from "./fs"

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
    )
}

/** True when this JSON manifest carries a host-facing cache key we SHA-stamp. */
function isVersionedManifest(relPosix: string): boolean {
    return (
        relPosix.endsWith("/marketplace.json") ||
        relPosix.endsWith("/plugin.json") ||
        relPosix.endsWith("/gemini-extension.json")
    )
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
    const ripperdoc = join(repoRoot, "src", "ripperdoc")
    const stage = join(repoRoot, STAGE_ROOT)
    if (!existsSync(ripperdoc) || !statSync(ripperdoc).isDirectory()) {
        return []
    }

    const written: string[] = []
    if (dryRun) {
        for (const src of walkFiles(ripperdoc)) {
            const rel = relative(ripperdoc, src).split(sep).join("/")
            if (isMirroredPrimitive(`/${rel}`)) {
                written.push(join(stage, ...rel.split("/")))
            }
        }
        // Caller (installFor) reports the count under its phase; stay silent to avoid a
        // duplicate, un-indented line in the dry-run render.
        return written
    }

    // Rebuild from scratch: a stale primitive must never survive a re-install.
    rmSync(stage, { recursive: true, force: true })
    for (const src of walkFiles(ripperdoc)) {
        const rel = relative(ripperdoc, src).split(sep).join("/")
        // Leading "/" anchors the suffix matchers to a rack-relative boundary.
        if (!isMirroredPrimitive(`/${rel}`)) {
            continue
        }
        const dst = join(stage, ...rel.split("/"))
        mkdirSync(dirname(dst), { recursive: true })
        copyFileSync(src, dst)
        written.push(dst)
    }
    return written
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
        return
    }
    let sha = ""
    try {
        const r = await reap(Bun.spawn(["git", "-C", repoRoot, "describe", "--tags", "--always"], PIPED), 10_000)
        if (r.exitCode === 0) {
            sha = r.stdout.trim()
        }
    } catch {
        // not a git repo / git missing — leave versions unchanged
    }
    if (!sha) {
        return
    }
    for (const path of mirrored) {
        const relPosix = `/${relative(join(repoRoot, STAGE_ROOT), path).split(sep).join("/")}`
        if (!isVersionedManifest(relPosix)) {
            continue
        }
        try {
            const data = JSON.parse(readFileSync(path, "utf8"))
            if (data === null || typeof data !== "object" || Array.isArray(data)) {
                continue
            }
            let changed = false
            // plugin.json / gemini-extension.json carry the cache key at the top level.
            if ("version" in data) {
                data.version = sha
                changed = true
            }
            // marketplace.json has NO top-level version — its per-plugin cache keys are
            // nested in plugins[].version, so stamp each entry too.
            if (Array.isArray(data.plugins)) {
                for (const entry of data.plugins) {
                    if (entry !== null && typeof entry === "object" && "version" in entry) {
                        entry.version = sha
                        changed = true
                    }
                }
            }
            if (changed) {
                writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`)
            }
        } catch {
            // unparseable / unwritable manifest — skip it, never abort the stamp
        }
    }
}
