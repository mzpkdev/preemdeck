/**
 * ghost.spec.ts — Tmp-fixture FS; the stdout side is captured
 * via the injected `log` sink rather than spying console.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { decode, encode, flatline, MAPPINGS, main } from "./ghost"

const context = describe

let dir = ""
const lines: string[] = []
const log = (l: string) => {
    lines.push(l)
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "preemdeck-ghost-"))
    lines.length = 0
})
afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")
const decodeDat = async (p: string) => Buffer.from((await readFile(p)).toString("utf8"), "base64").toString("utf8")

describe("ghost", () => {
    context("encoding the persona", () => {
        it("encodes <MD> to base64 <DAT>", async () => {
            await writeFile(join(dir, "ENGRAM.md"), "engram content")
            await encode(dir, log)
            const dat = join(dir, "engram.dat")
            expect(existsSync(dat)).toBe(true)
            expect(await decodeDat(dat)).toBe("engram content")
        })

        it("removes the <MD> after encoding", async () => {
            await writeFile(join(dir, "ENGRAM.md"), "engram content")
            await encode(dir, log)
            expect(existsSync(join(dir, "ENGRAM.md"))).toBe(false)
        })

        it("skips missing <MD> files", async () => {
            await writeFile(join(dir, "PULSE.md"), "pulse")
            await encode(dir, log)
            expect(existsSync(join(dir, "pulse.dat"))).toBe(true)
            expect(existsSync(join(dir, "engram.dat"))).toBe(false)
        })

        it("prints the mapping line", async () => {
            await writeFile(join(dir, "FIRMWARE.md"), "fw")
            await encode(dir, log)
            expect(lines).toContain("FIRMWARE.md -> firmware.dat")
        })

        it("encodes all mappings", async () => {
            for (const [mdName] of MAPPINGS) await writeFile(join(dir, mdName), `content of ${mdName}`)
            await encode(dir, log)
            for (const [, datName] of MAPPINGS) expect(existsSync(join(dir, datName))).toBe(true)
        })
    })

    context("decoding the persona", () => {
        it("decodes <DAT> back to <MD>", async () => {
            await writeFile(join(dir, "engram.dat"), b64("engram data"))
            await decode(dir, log)
            const md = join(dir, "ENGRAM.md")
            expect(existsSync(md)).toBe(true)
            expect(await readFile(md, "utf8")).toBe("engram data")
        })

        it("skips missing <DAT> files", async () => {
            await writeFile(join(dir, "pulse.dat"), b64("pulse data"))
            await decode(dir, log)
            expect(existsSync(join(dir, "PULSE.md"))).toBe(true)
            expect(existsSync(join(dir, "ENGRAM.md"))).toBe(false)
        })

        it("prints the mapping line", async () => {
            await writeFile(join(dir, "pulse.dat"), b64("pulse"))
            await decode(dir, log)
            expect(lines).toContain("pulse.dat -> PULSE.md")
        })

        it("does not remove the <DAT> (non-destructive)", async () => {
            await writeFile(join(dir, "engram.dat"), b64("data"))
            await decode(dir, log)
            expect(existsSync(join(dir, "engram.dat"))).toBe(true)
        })
    })

    context("flatlining to stock", () => {
        async function seedStock() {
            await mkdir(join(dir, "stock"))
            for (const [mdName] of MAPPINGS) await writeFile(join(dir, "stock", mdName), `stock ${mdName}`)
        }

        it("restores stock then encodes (dat files exist after)", async () => {
            await seedStock()
            await flatline(dir, log)
            for (const [, datName] of MAPPINGS) expect(existsSync(join(dir, datName))).toBe(true)
        })

        it("prints 'persona wiped to stock'", async () => {
            await seedStock()
            await flatline(dir, log)
            expect(lines).toContain("persona wiped to stock")
        })

        it("skips stock <MD> not present", async () => {
            await mkdir(join(dir, "stock"))
            await writeFile(join(dir, "stock", "PULSE.md"), "stock pulse")
            await flatline(dir, log)
            expect(existsSync(join(dir, "pulse.dat"))).toBe(true)
            expect(existsSync(join(dir, "engram.dat"))).toBe(false)
        })
    })

    context("when run via main", () => {
        it("runs the encode command", async () => {
            await writeFile(join(dir, "PULSE.md"), "pulse")
            expect(await main(["encode"], dir, log)).toBe(0)
            expect(existsSync(join(dir, "pulse.dat"))).toBe(true)
        })

        it("runs the decode command", async () => {
            await writeFile(join(dir, "pulse.dat"), b64("pulse data"))
            expect(await main(["decode"], dir, log)).toBe(0)
            expect(existsSync(join(dir, "PULSE.md"))).toBe(true)
        })

        it("returns 1 for an unknown command", async () => {
            expect(await main(["bogus"], dir, log)).toBe(1)
        })

        it("returns 1 for no command", async () => {
            expect(await main([], dir, log)).toBe(1)
        })

        it("returns 0 and prints for the flatline command", async () => {
            await mkdir(join(dir, "stock"))
            expect(await main(["flatline"], dir, log)).toBe(0)
            expect(lines).toContain("persona wiped to stock")
        })
    })
})
