import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

const context = describe

const run = async (
    args: string[],
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "open-inline.ts"), ...args], {
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
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "preemdeck-openinline-"))
})
afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true })
})

describe("open-inline CLI", () => {
    context("on a live IDE", () => {
        it("exits 0 and writes nothing to stdout under --dry-run", async () => {
            const { code, stdout, stderr } = await run(["some text", "--dry-run"])
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })

        it("prints the spilled content back to stdout under --wait", async () => {
            const content = "hello inline\nsecond line\n"
            const { code, stdout } = await run([content, "--wait", "--dry-run"])
            expect(code).toBe(0)
            expect(stdout).toBe(content)
        })

        it("accepts --suffix and exits 0", async () => {
            const { code, stdout, stderr } = await run(["x = 1", "--suffix", ".ts", "--dry-run"])
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })

        it("accepts --preview and exits 0", async () => {
            const { code, stderr } = await run(["# title", "--suffix", ".md", "--preview", "--dry-run"])
            expect(code).toBe(0)
            expect(stderr).toBe("")
        })
    })

    context("temp lifecycle", () => {
        it("reaps its spilled temp(s) on the no-wait path", async () => {
            // TMPDIR redirect: os.tmpdir() honors it, so writeTemp spills into our
            // hermetic test dir. The reap-aware tail + delay 0 reaps BEFORE exit.
            const { code } = await run(["some text", "--dry-run"], {
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
            const { code, stdout, stderr } = await run(["body"], { PREEMDECK_FORCE_IN_IDEA: "0" })
            expect(code).toBe(1)
            expect(stdout).toBe("")
            expect(stderr).toContain("no JetBrains IDE in the process ancestry")
        })

        it("fires the gate before the dry-run skip", async () => {
            const { code, stderr } = await run(["body", "--dry-run"], { PREEMDECK_FORCE_IN_IDEA: "0" })
            expect(code).toBe(1)
            expect(stderr).toContain("no JetBrains IDE in the process ancestry")
        })
    })

    context("given malformed arguments", () => {
        it.each([
            ["an unknown flag", ["body", "--bogus"], 'An option "--bogus" is unknown.'],
            ["a missing required inline", [], 'An argument "inline" is required.']
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
            expect(stdout).toContain("open-inline")
        })
    })
})
