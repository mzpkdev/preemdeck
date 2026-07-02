/**
 * manifest.spec.ts — install-manifest model suite.
 *
 * recordHarness (install-side merge) + writeManifest (uninstall-side write-or-delete) +
 * loadManifest, all against a tmp mkdtemp fixture.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MANIFEST_FILE, MANIFEST_SCHEMA } from "./constants"
import { loadManifest, recordHarness, writeManifest } from "./manifest"
import { silenceLog } from "./testkit"

const context = describe

let dir = ""

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "preemdeck-manifest-"))
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

function seedManifest(payload: unknown): void {
    writeFileSync(join(dir, MANIFEST_FILE), typeof payload === "string" ? payload : JSON.stringify(payload))
}

describe("manifest", () => {
    context("recordHarness", () => {
        it("writes schema + harness record", () => {
            const overlay = [
                {
                    dst: "/c/settings.json",
                    src: "src/overwrite/claude/settings.json",
                    backup: null,
                    action: "create" as const
                }
            ]
            recordHarness(dir, "claude", overlay, ["dock"], [{ name: "fixer" }], false)

            const data = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"))
            expect(data.schema).toBe(MANIFEST_SCHEMA)
            expect(Object.keys(data.harnesses)).toEqual(["claude"])
            expect(data.harnesses.claude.overlay).toEqual(overlay)
            expect(data.harnesses.claude.marketplaces).toEqual(["dock"])
            expect(data.harnesses.claude.plugins).toEqual([{ name: "fixer" }])
            expect("installed_at" in data.harnesses.claude).toBe(true)
        })

        it("merges across harnesses", () => {
            recordHarness(dir, "claude", [], ["dock"], [], false)
            recordHarness(dir, "gemini", [], [], [], false)
            const data = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"))
            expect(new Set(Object.keys(data.harnesses))).toEqual(new Set(["claude", "gemini"]))
        })

        it("replaces the same harness", () => {
            recordHarness(dir, "claude", [], ["dock"], [], false)
            recordHarness(dir, "claude", [], ["chrome", "dock"], [], false)
            const data = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"))
            expect(data.harnesses.claude.marketplaces).toEqual(["chrome", "dock"])
        })

        it("dry-run writes nothing (and prints nothing — narration lives in installFor)", () => {
            recordHarness(dir, "claude", [], [], [], true)
            expect(() => readFileSync(join(dir, MANIFEST_FILE), "utf8")).toThrow()
        })

        it("emits 2-space indent + trailing newline (schema-1 shape)", () => {
            recordHarness(dir, "claude", [], [], [], false)
            const text = readFileSync(join(dir, MANIFEST_FILE), "utf8")
            expect(text.endsWith("\n")).toBe(true)
            expect(text).toContain('\n  "schema": 1,')
        })
    })

    context("writeManifest", () => {
        it("rewrites when harnesses remain", () => {
            const manifest = { schema: MANIFEST_SCHEMA, harnesses: { gemini: { overlay: [] } } }
            const logSpy = silenceLog()
            try {
                writeManifest(dir, manifest, false)
            } finally {
                logSpy.mockRestore()
            }
            const data = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"))
            expect(new Set(Object.keys(data.harnesses))).toEqual(new Set(["gemini"]))
        })

        it("deletes the file when empty", () => {
            seedManifest({ schema: MANIFEST_SCHEMA, harnesses: {} })
            writeManifest(dir, { schema: MANIFEST_SCHEMA, harnesses: {} }, false)
            expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false)
        })

        it("dry-run never writes", () => {
            const logSpy = silenceLog()
            try {
                writeManifest(dir, { schema: MANIFEST_SCHEMA, harnesses: { gemini: {} } }, true)
            } finally {
                logSpy.mockRestore()
            }
            expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false)
        })
    })

    context("loadManifest", () => {
        it("skeleton when missing", () => {
            expect(loadManifest(dir)).toEqual({ schema: MANIFEST_SCHEMA, harnesses: {} })
        })

        it("skeleton when corrupt", () => {
            writeFileSync(join(dir, MANIFEST_FILE), "not json{")
            expect(loadManifest(dir)).toEqual({ schema: MANIFEST_SCHEMA, harnesses: {} })
        })

        it("reads valid", () => {
            const payload = { schema: 1, harnesses: { claude: { overlay: [] } } }
            writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(payload))
            expect(loadManifest(dir)).toEqual(payload)
        })
    })
})
