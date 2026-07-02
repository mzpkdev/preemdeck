/**
 * overlay.ts — copy the per-harness overlay into the host config dir, backing up once.
 *
 * `src/overwrite/<harness>/*` is hard-overwritten into configDir; a genuinely pre-existing
 * user file (no prior manifest record) is backed up once via the `.bak`/`.bak.<ts>` scheme
 * before it is clobbered. Files we wrote on a prior run are never re-backed-up.
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { STAGING_ROOT } from "./constants"
import { walkFiles } from "./fs"
import { loadManifest, type OverlayRecord } from "./manifest"

/**
 * Pick a backup path for dst, mirroring boot.sh's `.bak` → `.bak.<ts>` scheme.
 *
 * First clobber of a pre-existing file lands at `<dst>.bak`; if that already
 * exists, fall back to `<dst>.bak.<unix_ts>` so an earlier backup is never lost.
 */
export function backupPath(dst: string): string {
    const primary = `${dst}.bak`
    if (!existsSync(primary)) {
        return primary
    }
    return `${dst}.bak.${Math.floor(Date.now() / 1000)}`
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
    dryRun: boolean
): [boolean, string, OverlayRecord[]] {
    const srcRoot = join(repoRoot, STAGING_ROOT, harness)
    if (!existsSync(srcRoot) || !statSync(srcRoot).isDirectory()) {
        // No overlay for this harness is fine — nothing to copy.
        return [true, "", []]
    }

    // Files we previously wrote for this harness must not be treated as
    // pre-existing user files, so we never back up our own output.
    const prior = loadManifest(repoRoot).harnesses[harness] ?? {}
    const ownWrites = new Set<string>()
    for (const rec of prior.overlay ?? []) {
        if (rec.dst) ownWrites.add(rec.dst)
    }

    const records: OverlayRecord[] = []
    try {
        for (const src of walkFiles(srcRoot).sort()) {
            const rel = relative(srcRoot, src)
            const dst = join(configDirPath, rel)
            const dstAbs = dst
            const existed = existsSync(dst)
            let backup: string | null = null

            if (existed && !ownWrites.has(dstAbs)) {
                const bak = backupPath(dst)
                backup = bak
                if (!dryRun) {
                    copyFileSync(dst, bak)
                }
            }

            if (!dryRun) {
                mkdirSync(dirname(dst), { recursive: true })
                copyFileSync(src, dst)
            }

            records.push({
                dst: dstAbs,
                src: relative(repoRoot, src),
                backup,
                action: existed ? "overwrite" : "create"
            })
        }
    } catch (exc) {
        const message = exc instanceof Error ? exc.message : String(exc)
        return [false, `overlay copy failed: ${message}`, records]
    }

    return [true, "", records]
}
