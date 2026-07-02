/**
 * install.spec.ts — installFor orchestration suite.
 *
 * Behavior via the spawn mock (harness presence is an `onPath` spawn). repoRoot is a tmp
 * dir so even the non-dry path has no real overlay/manifest to touch.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installFor } from "./install"
import { fakeChild, silenceLog } from "./testkit"

const context = describe

let spawnSpy: ReturnType<typeof spyOn<typeof Bun, "spawn">>

let dir = ""

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "preemdeck-install-"))
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => fakeChild())
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    spawnSpy.mockRestore()
})

describe("install", () => {
    context("installFor", () => {
        it("returns 1 when the harness is not on PATH", async () => {
            // onPath() shells out to `sh -c command -v` — make that probe fail (exit 1).
            spawnSpy.mockImplementation((cmd) => ((cmd as string[])[0] === "sh" ? fakeChild("", 1) : fakeChild()))
            const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
            const logSpy = silenceLog()
            try {
                const rc = await installFor("claude", dir, false)
                expect(rc).toBe(1)
                const wrote = errSpy.mock.calls.map((c) => String(c[0])).join("")
                expect(wrote).toContain("not on PATH")
            } finally {
                logSpy.mockRestore()
                errSpy.mockRestore()
            }
        })

        it("dry-run returns 0 (harness present, no real subprocess work)", async () => {
            // onPath probe succeeds; in dry-run copyOverlay/recordHarness write nothing, and
            // the tmp repoRoot has no overlay/mirror, so this is a clean no-op run.
            spawnSpy.mockImplementation(() => fakeChild())
            const logSpy = silenceLog()
            try {
                const rc = await installFor("claude", dir, true)
                expect(rc).toBe(0)
            } finally {
                logSpy.mockRestore()
            }
        })
    })
})
