/**
 * trash — suite for devscripts/trash.ts.
 *
 * parseTrash / sparseArgs are pure → asserted directly. applyTrash routes its one
 * shell-out through `Bun.spawn` + `reap`; we spy on `Bun.spawn` to capture the git
 * argv and serve a canned child (scripted exit codes / throws) WITHOUT touching a
 * real repo. The real sparse-checkout behavior (git's job) is covered by the
 * boot.sh deploy path.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyTrash, parseTrash, sparseArgs } from "./trash.ts"

const context = describe

// A canned Bun.Subprocess: stdout/stderr as drainable streams, a resolved exit.
// reap() reads the streams to text and awaits `exited`, so this stands in for a
// real child without spawning one.
const fakeChild = (stdout = "", exitCode = 0, stderr = "") =>
    ({
        stdout: new Response(stdout).body,
        stderr: new Response(stderr).body,
        exited: Promise.resolve(exitCode),
        exitCode,
        kill() {}
    }) as unknown as Bun.Subprocess

describe("trash", () => {
    context("parseTrash", () => {
        it("keeps patterns, trims them, and drops blanks and # comments", () => {
            expect(parseTrash("# header\n\n  /.github  \n*.test.ts\n   \n#tail")).toEqual(["/.github", "*.test.ts"])
        })

        it("returns an empty list for empty input", () => {
            expect(parseTrash("")).toEqual([])
        })
    })

    context("sparseArgs", () => {
        it("negates each pattern after the keep-all includes", () => {
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

        it("emits just the keep-all includes when there are no patterns", () => {
            expect(sparseArgs([])).toEqual(["sparse-checkout", "set", "--no-cone", "/*", "/.*"])
        })
    })

    context("applyTrash", () => {
        let spawnSpy: ReturnType<typeof spyOn<typeof Bun, "spawn">>
        let dir: string

        // The argv each Bun.spawn call received (cmd is the first positional).
        const calls = (): string[][] => spawnSpy.mock.calls.map((c) => c[0] as string[])

        beforeEach(() => {
            dir = mkdtempSync(join(tmpdir(), "preemdeck-trash-"))
            spawnSpy = spyOn(Bun, "spawn").mockReturnValue(fakeChild())
        })

        afterEach(() => {
            rmSync(dir, { recursive: true, force: true })
            spawnSpy.mockRestore()
        })

        it("does not spawn when .trash is missing", async () => {
            await applyTrash(dir)
            expect(calls()).toEqual([])
        })

        it("does not spawn for a comment/blank-only .trash", async () => {
            writeFileSync(join(dir, ".trash"), "# just docs\n\n   \n")
            await applyTrash(dir)
            expect(calls()).toEqual([])
        })

        it("builds the git sparse-checkout argv from .trash", async () => {
            writeFileSync(join(dir, ".trash"), "# c\n/.github\n*.test.ts\n")
            await applyTrash(dir)
            expect(calls()).toEqual([
                ["git", "-C", dir, "sparse-checkout", "set", "--no-cone", "/*", "/.*", "!/.github", "!*.test.ts"]
            ])
        })

        it("resolves and never throws on a non-zero git exit", async () => {
            writeFileSync(join(dir, ".trash"), "/.github\n")
            spawnSpy.mockReturnValue(fakeChild("", 128, "git too old"))
            await expect(applyTrash(dir)).resolves.toBeUndefined()
        })

        it("swallows a spawn throw", async () => {
            writeFileSync(join(dir, ".trash"), "/.github\n")
            spawnSpy.mockImplementation(() => {
                throw new Error("ENOENT")
            })
            await expect(applyTrash(dir)).resolves.toBeUndefined()
        })
    })
})
