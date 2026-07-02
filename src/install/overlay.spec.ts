/**
 * overlay.spec.ts — overlay copier + backup-path suite.
 *
 * A tmp mkdtemp fixture backs the real-FS copy/backup cases; the repeat-install case seeds
 * a prior manifest via recordHarness so a recorded file is not re-backed-up.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { recordHarness } from "./manifest"
import { backupPath, copyOverlay } from "./overlay"
import { seedOverlay } from "./testkit"

const context = describe

let dir = ""

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "preemdeck-overlay-"))
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

describe("overlay", () => {
    context("copyOverlay", () => {
        it("create, no backup", () => {
            const repoRoot = join(dir, "repo")
            const config = join(dir, "config")
            seedOverlay(repoRoot)

            const [r, err, records] = copyOverlay("claude", repoRoot, config, false)

            expect([r, err]).toEqual([true, ""])
            expect(readFileSync(join(config, "settings.json"), "utf8")).toBe('{"_": "overlay"}')
            expect(readFileSync(join(config, "agents", "fixer.md"), "utf8")).toBe("# fixer overlay")
            expect(new Set(records.map((rec) => rec.action))).toEqual(new Set(["create"]))
            expect(records.every((rec) => rec.backup === null)).toBe(true)
            for (const rec of records) {
                expect(rec.src.startsWith("/")).toBe(false) // repo-relative
                expect(rec.dst.startsWith("/")).toBe(true) // absolute
            }
        })

        it("missing root returns empty", () => {
            const repoRoot = join(dir, "repo")
            mkdirSync(repoRoot, { recursive: true })
            const config = join(dir, "config")
            expect(copyOverlay("claude", repoRoot, config, false)).toEqual([true, "", []])
        })

        it("overwrite backs up the original once at .bak", () => {
            const repoRoot = join(dir, "repo")
            const config = join(dir, "config")
            seedOverlay(repoRoot)
            mkdirSync(config, { recursive: true })
            writeFileSync(join(config, "settings.json"), '{"_": "user-original"}')

            const [r, err, records] = copyOverlay("claude", repoRoot, config, false)

            expect([r, err]).toEqual([true, ""])
            expect(readFileSync(join(config, "settings.json.bak"), "utf8")).toBe('{"_": "user-original"}')
            expect(readFileSync(join(config, "settings.json"), "utf8")).toBe('{"_": "overlay"}')
            const rec = records.find((x) => x.dst.endsWith("settings.json"))
            expect(rec?.action).toBe("overwrite")
            expect(rec?.backup).toBe(join(config, "settings.json.bak"))
        })

        it("repeat install skips re-backup for a recorded file", () => {
            const repoRoot = join(dir, "repo")
            const config = join(dir, "config")
            seedOverlay(repoRoot)
            mkdirSync(config, { recursive: true })
            writeFileSync(join(config, "settings.json"), '{"_": "user-original"}')

            const [, , records1] = copyOverlay("claude", repoRoot, config, false)
            recordHarness(repoRoot, "claude", records1, [], [], false)
            expect(readFileSync(join(config, "settings.json.bak"), "utf8")).toBe('{"_": "user-original"}')

            writeFileSync(join(repoRoot, "src", "overwrite", "claude", "settings.json"), '{"_": "overlay-v2"}')
            const [, , records2] = copyOverlay("claude", repoRoot, config, false)

            expect(readFileSync(join(config, "settings.json"), "utf8")).toBe('{"_": "overlay-v2"}')
            expect(readFileSync(join(config, "settings.json.bak"), "utf8")).toBe('{"_": "user-original"}')
            const rec = records2.find((x) => x.dst.endsWith("settings.json"))
            expect(rec?.backup).toBe(null)
            expect(rec?.action).toBe("overwrite")
        })

        it("second backup uses a timestamp suffix when .bak is taken", () => {
            const repoRoot = join(dir, "repo")
            const config = join(dir, "config")
            seedOverlay(repoRoot)
            mkdirSync(config, { recursive: true })
            writeFileSync(join(config, "settings.json"), '{"_": "user-original"}')
            writeFileSync(join(config, "settings.json.bak"), '{"_": "stale-bak"}')

            const [, , records] = copyOverlay("claude", repoRoot, config, false)

            expect(readFileSync(join(config, "settings.json.bak"), "utf8")).toBe('{"_": "stale-bak"}')
            const rec = records.find((x) => x.dst.endsWith("settings.json"))
            expect(rec?.backup).toMatch(/settings\.json\.bak\.\d+$/)
            expect(readFileSync(rec?.backup as string, "utf8")).toBe('{"_": "user-original"}')
        })

        it("dry-run writes nothing but still produces records", () => {
            const repoRoot = join(dir, "repo")
            const config = join(dir, "config")
            seedOverlay(repoRoot)
            mkdirSync(config, { recursive: true })
            writeFileSync(join(config, "settings.json"), '{"_": "user-original"}')

            const [r, err, records] = copyOverlay("claude", repoRoot, config, true)

            expect([r, err]).toEqual([true, ""])
            expect(readFileSync(join(config, "settings.json"), "utf8")).toBe('{"_": "user-original"}')
            expect(() => readFileSync(join(config, "settings.json.bak"), "utf8")).toThrow()
            expect(records.length).toBe(2)
            const rec = records.find((x) => x.dst.endsWith("settings.json"))
            expect(rec?.action).toBe("overwrite")
            expect(rec?.backup).toBe(join(config, "settings.json.bak"))
        })
    })

    context("backupPath", () => {
        it("returns .bak when free, .bak.<ts> when taken", () => {
            const target = join(dir, "x.json")
            expect(backupPath(target)).toBe(`${target}.bak`)
            writeFileSync(`${target}.bak`, "taken")
            expect(backupPath(target)).toMatch(/x\.json\.bak\.\d+$/)
        })
    })
})
