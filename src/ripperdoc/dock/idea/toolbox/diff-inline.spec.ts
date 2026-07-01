import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

const context = describe

const run = async (
    args: string[],
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "diff-inline.ts"), ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PREEMDECK_FORCE_IN_IDEA: "1", PREEMDECK_REAP_DELAY_MS: "0", ...environment }
    })
    const [stdout, stderr] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text()
    ])
    const code = await subprocess.exited
    return { code, stdout, stderr }
}

let directory = ""
beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "preemdeck-diffinline-"))
})
afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true })
})

describe("diff-inline CLI", () => {
    context("on a live IDE", () => {
        it("exits 0 and writes nothing to stdout under --dry-run", async () => {
            const { code, stdout, stderr } = await run(["--dry-run", "alpha", "beta"])
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })

        it("prints the LEFT (target) string back to stdout under --wait", async () => {
            const { code, stdout } = await run(["--wait", "--dry-run", "old", "new"])
            expect(code).toBe(0)
            expect(stdout).toBe("old")
        })

        it("reports diagnostic detail on stderr under --verbose --dry-run", async () => {
            const { code, stderr } = await run(["--verbose", "--dry-run", "alpha", "beta"])
            expect(code).toBe(0)
            expect(stderr).toContain("diff-inline:")
        })

        it("stays silent on stderr without --verbose", async () => {
            const { code, stderr } = await run(["--dry-run", "alpha", "beta"])
            expect(code).toBe(0)
            expect(stderr).toBe("")
        })
    })

    context("temp lifecycle", () => {
        it("reaps its spilled temp(s) on the no-wait path", async () => {
            // TMPDIR redirect: os.tmpdir() honors it, so writeTemp spills into our
            // hermetic test dir. The reap-aware tail + delay 0 reaps BEFORE exit.
            const { code } = await run(["--dry-run", "alpha", "beta"], {
                TMPDIR: directory,
                PREEMDECK_REAP_DELAY_MS: "0"
            })
            expect(code).toBe(0)
            const leaked = (await fs.readdir(directory)).filter((name) => name.startsWith("idea-tmp-"))
            expect(leaked).toEqual([])
        })
    })

    context("without a live IDE", () => {
        it("exits 1 with the IdeaError on stderr", async () => {
            const { code, stdout, stderr } = await run(["alpha", "beta"], { PREEMDECK_FORCE_IN_IDEA: "0" })
            expect(code).toBe(1)
            expect(stdout).toBe("")
            expect(stderr).toContain("no JetBrains IDE in the process ancestry")
        })
    })

    context("given malformed arguments", () => {
        it.each([
            ["a missing required suggestion", ["only"], 'An argument "suggestion" is required.'],
            ["an unknown flag", ["--bogus", "a", "b"], 'An option "--bogus" is unknown.'],
            ["a missing required target", [], 'An argument "target" is required.']
        ] as [string, string[], string][])("exits 2 given %s", async (_label, args, fragment) => {
            const { code, stderr } = await run(args)
            expect(code).toBe(2)
            expect(stderr).toContain(fragment)
        })
    })

    context("with --help", () => {
        it("exits 0 and prints usage to stdout", async () => {
            const { code, stdout } = await run(["--help"])
            expect(code).toBe(0)
            expect(stdout).toContain("diff-inline")
        })
    })
})
