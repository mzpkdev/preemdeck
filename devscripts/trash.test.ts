/**
 * trash.test.ts — suite for devscripts/trash.ts.
 *
 * parseTrash / sparseArgs are pure → asserted directly. applyTrash routes its one
 * shell-out through `_internals.spawn`; we override that seam to capture the git
 * argv and script exit codes/throws WITHOUT touching a real repo. The real
 * sparse-checkout behavior (git's job) is covered by the boot.sh deploy path.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SpawnOptions, SpawnResult } from "../source/common/proc.ts"
import { _internals, applyTrash, parseTrash, sparseArgs } from "./trash.ts"

describe("parseTrash", () => {
    test("keeps patterns; trims; drops blanks and # comments", () => {
        expect(parseTrash("# header\n\n  /.github  \n*.test.ts\n   \n#tail")).toEqual(["/.github", "*.test.ts"])
    })

    test("empty input → empty list", () => {
        expect(parseTrash("")).toEqual([])
    })
})

describe("sparseArgs", () => {
    test("negates each pattern after the keep-all includes", () => {
        expect(sparseArgs(["/.github", "*.test.ts"])).toEqual([
            "sparse-checkout",
            "set",
            "--no-cone",
            "/*",
            "/.*",
            "!/.github",
            "!*.test.ts"
        ])
    })

    test("no patterns → just the keep-all includes", () => {
        expect(sparseArgs([])).toEqual(["sparse-checkout", "set", "--no-cone", "/*", "/.*"])
    })
})

describe("applyTrash", () => {
    const realSpawn = _internals.spawn
    const ok: SpawnResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false }
    let calls: string[][]
    let impl: (cmd: string[], opts?: SpawnOptions) => Promise<SpawnResult>
    let dir: string

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "preemdeck-trash-"))
        calls = []
        impl = async () => ok
        _internals.spawn = (cmd: string[], opts?: SpawnOptions) => {
            calls.push(cmd)
            return impl(cmd, opts)
        }
    })

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
        _internals.spawn = realSpawn
    })

    test("missing .trash → no spawn", async () => {
        await applyTrash(dir)
        expect(calls).toEqual([])
    })

    test("comment/blank-only .trash → no spawn", async () => {
        writeFileSync(join(dir, ".trash"), "# just docs\n\n   \n")
        await applyTrash(dir)
        expect(calls).toEqual([])
    })

    test("builds the git sparse-checkout argv from .trash", async () => {
        writeFileSync(join(dir, ".trash"), "# c\n/.github\n*.test.ts\n")
        await applyTrash(dir)
        expect(calls).toEqual([
            ["git", "-C", dir, "sparse-checkout", "set", "--no-cone", "/*", "/.*", "!/.github", "!*.test.ts"]
        ])
    })

    test("non-zero git exit → resolves, never throws", async () => {
        writeFileSync(join(dir, ".trash"), "/.github\n")
        impl = async () => ({ ...ok, exitCode: 128, stderr: "git too old" })
        await expect(applyTrash(dir)).resolves.toBeUndefined()
    })

    test("spawn throw → swallowed", async () => {
        writeFileSync(join(dir, ".trash"), "/.github\n")
        impl = async () => {
            throw new Error("ENOENT")
        }
        await expect(applyTrash(dir)).resolves.toBeUndefined()
    })
})
