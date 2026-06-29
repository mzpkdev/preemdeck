/**
 * codec.spec.ts — pure base64 round-trip + the dat-or-md persona reader
 * (tmp-fixture FS).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { decode, encode, readSource } from "./codec"

const context = describe

let dir = ""
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "preemdeck-codec-"))
})
afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")

describe("codec", () => {
    context("base64 round-trip", () => {
        it("encodes UTF-8 text to base64", () => {
            expect(encode("hello")).toBe(b64("hello"))
        })
        it("decodes base64 back to the original text", () => {
            expect(decode(b64("hello"))).toBe("hello")
        })
        it("round-trips multi-line content", () => {
            const text = "multi\nline\ncontent"
            expect(decode(encode(text))).toBe(text)
        })
    })

    context("reading the persona source", () => {
        it("returns null when both are missing", async () => {
            expect(await readSource(dir, "engram.dat", "ENGRAM.md")).toBeNull()
        })
        it("reads the .dat (base64) over the .md", async () => {
            await writeFile(join(dir, "engram.dat"), b64("hello from dat"))
            await writeFile(join(dir, "ENGRAM.md"), "hello from md")
            expect(await readSource(dir, "engram.dat", "ENGRAM.md")).toBe("hello from dat")
        })
        it("reads the .md when the .dat is missing", async () => {
            await writeFile(join(dir, "ENGRAM.md"), "engram content")
            expect(await readSource(dir, "engram.dat", "ENGRAM.md")).toBe("engram content")
        })
        it("decodes multi-line base64 content", async () => {
            await writeFile(join(dir, "pulse.dat"), b64("multi\nline\ncontent"))
            expect(await readSource(dir, "pulse.dat", "PULSE.md")).toBe("multi\nline\ncontent")
        })
    })
})
