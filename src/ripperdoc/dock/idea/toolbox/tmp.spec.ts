/**
 * tmp.spec.ts — temp-file minting for the inline / merge CLIs. Real filesystem,
 * no mocks (MOCK PATTERN E): each helper mints a real temp in the system temp
 * dir, and we assert the file exists, ends with the suffix, and round-trips its
 * content. resolveStrict is checked against a real file (resolves) and a missing
 * path (throws ENOENT, which the CLIs catch).
 */

import { afterEach, describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join } from "node:path"
import { mkstemp, resolveStrict, writeTemp } from "./tmp"

const context = describe

// Clean up the flat temp files each helper mints directly under the system tmp dir.
const minted: string[] = []
const track = (path: string): string => {
    minted.push(path)
    return path
}

afterEach(async () => {
    while (minted.length > 0) {
        const path = minted.pop()
        if (path !== undefined) await rm(path, { force: true })
    }
})

describe("mkstemp", () => {
    it("creates a fresh empty flat file directly under the system temp dir, ending in the suffix", async () => {
        const path = track(await mkstemp(".md"))
        expect(existsSync(path)).toBe(true)
        expect(path.endsWith(".md")).toBe(true)
        // Flat file directly in tmpdir() (no per-call dir): its parent IS tmpdir()
        // and the basename carries the idea-tmp- prefix, so reapLater fully cleans it.
        expect(join(tmpdir(), basename(path))).toBe(path)
        expect(basename(path).startsWith("idea-tmp-")).toBe(true)
        expect(await Bun.file(path).text()).toBe("") // empty: the handle is closed right after creation
    })

    it("defaults the suffix to .txt", async () => {
        const path = track(await mkstemp())
        expect(path.endsWith(".txt")).toBe(true)
    })

    it("two calls mint distinct paths (UUIDv4 filename)", async () => {
        const a = track(await mkstemp(".txt"))
        const b = track(await mkstemp(".txt"))
        expect(a).not.toBe(b)
    })
})

describe("writeTemp", () => {
    it("spills the content to a fresh temp ending in the suffix and round-trips it", async () => {
        const path = track(await writeTemp("hello — world", ".groovy"))
        expect(path.endsWith(".groovy")).toBe(true)
        expect(existsSync(path)).toBe(true)
        expect(await Bun.file(path).text()).toBe("hello — world")
    })
})

describe("resolveStrict", () => {
    context("for an existing file", () => {
        it("resolves it to an absolute, symlink-resolved path", async () => {
            const path = track(await mkstemp(".txt"))
            const resolved = await resolveStrict(path)
            expect(isAbsolute(resolved)).toBe(true)
            expect(resolved.endsWith(".txt")).toBe(true)
            // realpath canonicalizes symlinks (e.g. macOS /var -> /private/var), so the
            // result lives under the realpath'd temp dir, not necessarily tmpdir() verbatim.
            expect(resolved.startsWith(await realpath(tmpdir()))).toBe(true)
        })
    })

    context("for a missing path", () => {
        it("throws ENOENT for a missing path", async () => {
            const missing = join(tmpdir(), `idea-nope-${crypto.randomUUID()}.txt`)
            await expect(resolveStrict(missing)).rejects.toMatchObject({ code: "ENOENT" })
        })
    })
})
