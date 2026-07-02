/**
 * deps.spec.ts — runtime-deps install suite (dry-run, verb/flag shape, failure surfacing).
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installDeps } from "./deps"
import { fakeChild } from "./testkit"

const context = describe

let spawnSpy: ReturnType<typeof spyOn<typeof Bun, "spawn">>
const spawnCalls = (): string[][] => spawnSpy.mock.calls.map((c) => c[0] as string[])

let dir = ""

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "preemdeck-deps-"))
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => fakeChild())
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    spawnSpy.mockRestore()
})

describe("deps", () => {
    context("installDeps", () => {
        it("dry-run returns ok without spawning", async () => {
            const [ok, err] = await installDeps(dir, true)
            expect(ok).toBe(true)
            expect(err).toBe("")
            expect(spawnCalls()).toEqual([])
        })

        it("runs `<bun> install --production`, ok on exit 0", async () => {
            spawnSpy.mockImplementation(() => fakeChild())
            const [ok, err] = await installDeps(dir, false)
            expect(ok).toBe(true)
            expect(err).toBe("")
            // argv[0] is the running Bun (process.execPath); assert the verb + flag.
            expect(spawnCalls()[0]?.slice(1)).toEqual(["install", "--production"])
        })

        it("non-zero exit surfaces stderr, then stdout, then a default", async () => {
            spawnSpy.mockImplementation(() => fakeChild("", 1, "  lockfile conflict  "))
            expect(await installDeps(dir, false)).toEqual([false, "lockfile conflict"])
            spawnSpy.mockImplementation(() => fakeChild("out-only", 1))
            expect(await installDeps(dir, false)).toEqual([false, "out-only"])
            spawnSpy.mockImplementation(() => fakeChild("", 1))
            expect(await installDeps(dir, false)).toEqual([false, "non-zero exit"])
        })
    })
})
