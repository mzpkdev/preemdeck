/**
 * lib/fs.test.ts — the async `exists` helper, the 1:1 replacement for
 * `existsSync` used across the migrated toolbox. Real filesystem in an isolated
 * tmp dir (MOCK PATTERN E): a real file resolves true, a missing sibling false.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { exists } from "./fs.ts"

let dir = ""

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "preemdeck-fs-"))
})

afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

describe("exists", () => {
    test("true for a real file", async () => {
        const path = join(dir, "real.txt")
        await writeFile(path, "x")
        expect(await exists(path)).toBe(true)
    })

    test("true for a real directory", async () => {
        expect(await exists(dir)).toBe(true)
    })

    test("false for a missing path", async () => {
        expect(await exists(join(dir, "nope.txt"))).toBe(false)
    })
})
