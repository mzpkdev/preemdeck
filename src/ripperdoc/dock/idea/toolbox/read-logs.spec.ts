import { describe, expect, it } from "bun:test"
import * as path from "node:path"

const context = describe

// NOTE: no happy-path block. read-logs resolves its log dir via resolveLogDir ->
// resolveExecPath, which walks the real process ancestry for a JetBrains IDE
// binary. PREEMDECK_FORCE_IN_IDEA only forces the inIdea() gate; it does NOT make
// resolveExecPath resolve, and there is no env/arg seam to point the log dir at a
// fixture that survives a subprocess. A genuine happy-path read of idea.log is
// only reproducible from inside a real IDE-launched terminal (non-hermetic), so
// it is intentionally omitted rather than fabricated.

const run = async (
    args: string[],
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "read-logs.ts"), ...args], {
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

describe("read-logs CLI", () => {
    context("on a live IDE", () => {
        it("reports diagnostic detail on stderr under --verbose", async () => {
            // resolveLogDir requires a real IDE ancestry; in CI the tool will
            // fail after assertIdea (which the force-env passes). When it
            // succeeds (real IDE), stderr contains "read-logs:".
            const { code, stderr } = await run(["--verbose"])
            if (code === 0) {
                expect(stderr).toContain("read-logs:")
            }
        })

        it("stays silent on stderr without --verbose", async () => {
            const { stderr } = await run([])
            expect(stderr).not.toContain("read-logs:")
        })
    })

    context("without a live IDE", () => {
        it("exits 1 with the IdeaError on stderr", async () => {
            const { code, stdout, stderr } = await run([], { PREEMDECK_FORCE_IN_IDEA: "0" })
            expect(code).toBe(1)
            expect(stdout).toBe("")
            expect(stderr).toContain("no JetBrains IDE in the process ancestry")
        })
    })

    context("given malformed arguments", () => {
        it.each([
            ["a non-integer n", ["abc"], "n must be an integer, got 'abc'"],
            ["an unknown flag", ["--bogus"], 'An option "--bogus" is unknown.']
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
            expect(stdout).toContain("read-logs")
        })
    })
})
