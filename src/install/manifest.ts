/**
 * manifest.ts — the install-manifest model + its readers/writers.
 *
 * One home for what were two colliding `writeManifest`s in separate files:
 *   * `recordHarness` — install-side per-harness MERGE (renamed from install's writeManifest).
 *   * `writeManifest` — uninstall-side write-or-delete of a full Manifest.
 * `loadManifest` reads either back, tolerating a missing/corrupt file.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { MANIFEST_FILE, MANIFEST_SCHEMA } from "./constants"

export interface OverlayRecord {
    dst: string
    src: string
    backup: string | null
    action: "create" | "overwrite"
}

export interface ManifestHarness {
    installed_at?: string
    overlay?: OverlayRecord[]
    marketplaces?: string[]
    plugins?: Array<Record<string, unknown>>
}

export interface Manifest {
    schema: number
    harnesses: Record<string, ManifestHarness>
}

/** Read the install manifest, returning an empty skeleton if absent/corrupt. */
export function loadManifest(repoRoot: string): Manifest {
    const path = join(repoRoot, MANIFEST_FILE)
    if (existsSync(path)) {
        try {
            const data = JSON.parse(readFileSync(path, "utf8"))
            if (
                data !== null &&
                typeof data === "object" &&
                !Array.isArray(data) &&
                typeof (data as { harnesses?: unknown }).harnesses === "object" &&
                (data as { harnesses?: unknown }).harnesses !== null &&
                !Array.isArray((data as { harnesses?: unknown }).harnesses)
            ) {
                return data as Manifest
            }
        } catch {
            // fall through to skeleton
        }
    }
    return { schema: MANIFEST_SCHEMA, harnesses: {} }
}

/**
 * Merge this install's record into the per-harness manifest at repoRoot.
 *
 * Keyed by harness and MERGED: re-installing one harness leaves every other
 * harness's record intact. Skips the write on a dry run (the caller narrates intent —
 * this module stays presentation-free, no skin import).
 */
export function recordHarness(
    repoRoot: string,
    harness: string,
    overlay: OverlayRecord[],
    marketplaces: string[],
    plugins: Array<Record<string, unknown>>,
    dryRun: boolean
): void {
    if (dryRun) {
        return
    }
    const manifest = loadManifest(repoRoot)
    manifest.schema = MANIFEST_SCHEMA
    manifest.harnesses[harness] = {
        installed_at: new Date().toISOString().replace(/Z$/, "+00:00"),
        overlay,
        marketplaces,
        plugins
    }
    writeFileSync(join(repoRoot, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
}

/** Persist the mutated manifest, or delete the file when no harnesses remain. */
export function writeManifest(repoRoot: string, manifest: Manifest, dryRun: boolean): void {
    const path = join(repoRoot, MANIFEST_FILE)
    if (Object.keys(manifest.harnesses).length > 0) {
        if (dryRun) {
            console.log(
                `  (dry-run) would rewrite manifest: ${Object.keys(manifest.harnesses).length} harness(es) remain`
            )
            return
        }
        writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
    } else {
        if (dryRun) {
            console.log(`  (dry-run) would delete manifest ${path} (no harnesses remain)`)
            return
        }
        rmSync(path, { force: true })
    }
}
