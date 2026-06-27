/**
 * lib/json-store.test.ts — also the canonical tmp-fixture mock pattern.
 *
 * MOCK PATTERN E — real filesystem in an isolated tmp dir. For I/O units, a
 * throwaway `mkdtemp` dir is cleaner and more faithful than mocking `fs`. Make it
 * in beforeEach, remove it in afterEach.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeJson } from "./json-store.ts"

let dir = ""
let path = ""

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "preemdeck-jsonstore-"))
    path = join(dir, "preemdeck.json")
})

afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

describe("jsonStore", () => {
    test("writeJson emits 2-space indent + trailing newline (byte-match the reference json.dumps)", async () => {
        await writeJson(path, { directive: { strategy: "swarm", discretion: "ask" } })
        const text = await Bun.file(path).text()
        expect(text).toBe('{\n  "directive": {\n    "strategy": "swarm",\n    "discretion": "ask"\n  }\n}\n')
    })

    test("writeJson serializes an object that round-trips back equal", async () => {
        const data = { directive: { strategy: "swarm" }, other: [1, 2, 3] }
        await writeJson(path, data)
        expect(JSON.parse(await Bun.file(path).text())).toEqual(data)
    })

    test("write does not leave a .tmp sibling behind", async () => {
        await writeJson(path, { a: 1 })
        expect(await Bun.file(`${path}.tmp`).exists()).toBe(false)
    })

    test("writeJson overwrites an existing file atomically (last write wins)", async () => {
        await writeJson(path, { v: 1 })
        await writeJson(path, { v: 2 })
        expect(JSON.parse(await Bun.file(path).text())).toEqual({ v: 2 })
    })
})
