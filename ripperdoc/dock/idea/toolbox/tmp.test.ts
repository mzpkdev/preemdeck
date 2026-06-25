/**
 * tmp.test.ts — temp-file minting for the inline / merge CLIs. Real filesystem,
 * no mocks (MOCK PATTERN E): each helper mints a real temp in the system temp
 * dir, and we assert the file exists, ends with the suffix, and round-trips its
 * content. resolveStrict is checked against a real file (resolves) and a missing
 * path (throws ENOENT, the FileNotFoundError parity the CLIs catch).
 */

import { afterEach, describe, expect, test } from "bun:test"
import { realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { exists } from "../../../../lib/fs.ts"
import { mkstemp, resolveStrict, writeTemp } from "./tmp.ts"

// Clean up the per-call private dirs each helper mints under the system tmp dir.
const minted: string[] = []
const track = (path: string): string => {
    minted.push(path)
    return path
}

afterEach(async () => {
    while (minted.length > 0) {
        const path = minted.pop()
        if (path !== undefined) await rm(dirname(path), { recursive: true, force: true })
    }
})

describe("mkstemp", () => {
    test("creates a fresh empty file under the system temp dir, ending in the suffix", async () => {
        const path = track(await mkstemp(".md"))
        expect(await exists(path)).toBe(true)
        expect(path.endsWith(".md")).toBe(true)
        expect(path.startsWith(tmpdir())).toBe(true)
        expect(await Bun.file(path).text()).toBe("") // empty, like os.close(fd) after mkstemp
    })

    test("defaults the suffix to .txt", async () => {
        const path = track(await mkstemp())
        expect(path.endsWith(".txt")).toBe(true)
    })

    test("two calls mint distinct paths (per-call private dir)", async () => {
        const a = track(await mkstemp(".txt"))
        const b = track(await mkstemp(".txt"))
        expect(a).not.toBe(b)
    })
})

describe("writeTemp", () => {
    test("spills the content to a fresh temp ending in the suffix and round-trips it", async () => {
        const path = track(await writeTemp("hello — world", ".groovy"))
        expect(path.endsWith(".groovy")).toBe(true)
        expect(await exists(path)).toBe(true)
        expect(await Bun.file(path).text()).toBe("hello — world")
    })
})

describe("resolveStrict", () => {
    test("resolves an existing file to an absolute, symlink-resolved path", async () => {
        const path = track(await mkstemp(".txt"))
        const resolved = await resolveStrict(path)
        expect(isAbsolute(resolved)).toBe(true)
        expect(resolved.endsWith(".txt")).toBe(true)
        // realpath canonicalizes symlinks (e.g. macOS /var -> /private/var), so the
        // result lives under the realpath'd temp dir, not necessarily tmpdir() verbatim.
        expect(resolved.startsWith(await realpath(tmpdir()))).toBe(true)
    })

    test("throws ENOENT for a missing path (FileNotFoundError parity)", async () => {
        const missing = join(tmpdir(), `idea-nope-${crypto.randomUUID()}.txt`)
        await expect(resolveStrict(missing)).rejects.toMatchObject({ code: "ENOENT" })
    })
})
