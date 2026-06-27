import { describe, expect, it } from "bun:test"
import * as path from "node:path"

const context = describe

const run = async (
    args: string[],
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "open-url.ts"), ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PREEMDECK_FORCE_IN_IDEA: "1", ...environment }
    })
    const [stdout, stderr] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text()
    ])
    const code = await subprocess.exited
    return { code, stdout, stderr }
}

describe("open-url CLI", () => {
    context("on a live IDE", () => {
        it("exits 0 and writes nothing to stdout under --dry-run", async () => {
            const { code, stdout, stderr } = await run(["--dry-run", "https://example.com"])
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })

        it("threads --title through and exits 0 under --dry-run", async () => {
            const { code, stdout } = await run(["--dry-run", "--title", "docs", "http://localhost:3000"])
            expect(code).toBe(0)
            expect(stdout).toBe("")
        })

        it("rejects a non-http scheme with exit 1 and the IdeaError on stderr", async () => {
            const { code, stdout, stderr } = await run(["--dry-run", "ftp://x"])
            expect(code).toBe(1)
            expect(stdout).toBe("")
            expect(stderr).toContain("url must be a non-empty http/https URL")
        })

        it("rejects a non-URL argument with exit 1", async () => {
            const { code, stdout, stderr } = await run(["--dry-run", "not-a-url"])
            expect(code).toBe(1)
            expect(stdout).toBe("")
            expect(stderr).toContain("url must be a non-empty http/https URL")
        })
    })

    context("without a live IDE", () => {
        it("exits 1 with the IdeaError on stderr, no browser fallback", async () => {
            const { code, stdout, stderr } = await run(["http://localhost:3000"], { PREEMDECK_FORCE_IN_IDEA: "0" })
            expect(code).toBe(1)
            expect(stdout).toBe("")
            expect(stderr).toContain("no JetBrains IDE in the process ancestry")
        })
    })

    context("given malformed arguments", () => {
        it.each([
            ["a missing required url", [], 'An argument "url" is required.'],
            ["an unknown flag", ["--bogus", "http://localhost:3000"], 'An option "--bogus" is unknown.']
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
            expect(stdout).toContain("open-url")
        })
    })
})
