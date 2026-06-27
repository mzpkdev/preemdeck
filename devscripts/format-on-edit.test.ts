/**
 * devscripts/format-on-edit.test.ts — unit tests for the side-effect format hook.
 *
 * Uses MOCK PATTERN A (inject a fake stdin into `main`) and PATTERN E (a real tmp
 * fixture for the containment / file-existence logic — no fs mocking). The pure
 * helpers (payload parse, path extraction, suffix map) are asserted directly; the
 * end-to-end "right formatter actually runs" check is the behavioral verification
 * step, not a unit test (it would shell out to biome/prettier).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    BIOME_SUFFIXES,
    biomeCmd,
    CONTAINMENT_ROOT,
    extractFilePath,
    PRETTIER_SUFFIXES,
    prettierCmd,
    readPayload,
    resolveInsideRoot,
    suffix
} from "./format-on-edit.ts"

const fakeStdin = (text: string) => ({ text: () => Promise.resolve(text) })

describe("readPayload", () => {
    test("parses a JSON object", async () => {
        expect(await readPayload(fakeStdin('{"a":1}'))).toEqual({ a: 1 })
    })

    test("empty / invalid / array / non-object stdin -> null (no-op)", async () => {
        expect(await readPayload(fakeStdin(""))).toBeNull()
        expect(await readPayload(fakeStdin("}{ not json"))).toBeNull()
        expect(await readPayload(fakeStdin("[1,2,3]"))).toBeNull()
        expect(await readPayload(fakeStdin("42"))).toBeNull()
        expect(await readPayload(fakeStdin("null"))).toBeNull()
    })
})

describe("extractFilePath", () => {
    test("probes file_path first", () => {
        expect(extractFilePath({ tool_input: { file_path: "/a/b.ts" } })).toBe("/a/b.ts")
    })

    test("falls back to absolute_path then path (Gemini's differing key)", () => {
        expect(extractFilePath({ tool_input: { absolute_path: "/a/c.ts" } })).toBe("/a/c.ts")
        expect(extractFilePath({ tool_input: { path: "/a/d.ts" } })).toBe("/a/d.ts")
    })

    test("first non-empty string wins (empty string skipped)", () => {
        expect(extractFilePath({ tool_input: { file_path: "", path: "/a/e.ts" } })).toBe("/a/e.ts")
    })

    test("missing / non-dict tool_input, or no usable key -> null", () => {
        expect(extractFilePath({})).toBeNull()
        expect(extractFilePath({ tool_input: null })).toBeNull()
        expect(extractFilePath({ tool_input: "x" })).toBeNull()
        expect(extractFilePath({ tool_input: ["a"] })).toBeNull()
        expect(extractFilePath({ tool_input: { other: "/a/f.ts" } })).toBeNull()
        expect(extractFilePath({ tool_input: { file_path: 123 } })).toBeNull()
    })
})

describe("suffix", () => {
    test("lowercased extension, dotfiles have none", () => {
        expect(suffix("/a/b.TS")).toBe(".ts")
        expect(suffix("/a/b.JSON")).toBe(".json")
        expect(suffix("/a/b.Markdown")).toBe(".markdown")
        expect(suffix("/a/no_ext")).toBe("")
        expect(suffix("/a/.bashrc")).toBe("")
        expect(suffix("/a.b/c.yaml")).toBe(".yaml")
    })
})

describe("formatter map", () => {
    test(".ts and .json both route to biome (via biomeCmd, lazily resolved)", async () => {
        expect(BIOME_SUFFIXES.has(".ts")).toBe(true)
        expect(BIOME_SUFFIXES.has(".json")).toBe(true)
        const cmd = await biomeCmd()
        expect(cmd.join(" ")).toContain("biome")
        expect(cmd).toContain("format")
        expect(cmd).toContain("--write")
    })

    test(".md / .markdown / .yml / .yaml all route to prettier (via prettierCmd, lazily resolved)", async () => {
        expect(PRETTIER_SUFFIXES.has(".md")).toBe(true)
        expect(PRETTIER_SUFFIXES.has(".markdown")).toBe(true)
        expect(PRETTIER_SUFFIXES.has(".yml")).toBe(true)
        expect(PRETTIER_SUFFIXES.has(".yaml")).toBe(true)
        const cmd = await prettierCmd()
        expect(cmd.join(" ")).toContain("prettier")
        expect(cmd).toContain("--write")
    })

    test("no formatter for unknown suffixes", () => {
        expect(BIOME_SUFFIXES.has(".rs")).toBe(false)
        expect(PRETTIER_SUFFIXES.has(".rs")).toBe(false)
        expect(BIOME_SUFFIXES.has("")).toBe(false)
        expect(PRETTIER_SUFFIXES.has("")).toBe(false)
    })
})

describe("resolveInsideRoot (PATTERN E — real tmp fixture)", () => {
    let dir: string

    beforeEach(async () => {
        // A tmp dir UNDER the containment root so the relative_to() guard passes.
        dir = await mkdtemp(join(CONTAINMENT_ROOT, ".fmt-test-"))
    })

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true })
    })

    test("an existing file under the root resolves to its absolute path", async () => {
        const f = join(dir, "x.ts")
        await writeFile(f, "const x=1;\n")
        expect(await resolveInsideRoot(f)).toBe(f)
    })

    test("a non-existent path -> null", async () => {
        expect(await resolveInsideRoot(join(dir, "nope.ts"))).toBeNull()
    })

    test("a directory (not a file) -> null", async () => {
        const sub = join(dir, "subdir")
        await mkdir(sub)
        expect(await resolveInsideRoot(sub)).toBeNull()
    })

    test("a file OUTSIDE the containment root -> null", async () => {
        // tmpdir() is /var/folders/... on macOS, /tmp on Linux — not under $HOME.
        const outside = await mkdtemp(join(tmpdir(), "fmt-outside-"))
        try {
            const f = join(outside, "y.ts")
            await writeFile(f, "const y=1;\n")
            expect(await resolveInsideRoot(f)).toBeNull()
        } finally {
            await rm(outside, { recursive: true, force: true })
        }
    })
})
