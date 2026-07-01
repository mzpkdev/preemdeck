import { describe, expect, it } from "bun:test"
import * as path from "node:path"

const context = describe

const run = async (
    args: string[],
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "in-idea.ts"), ...args], {
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

describe("in-idea CLI", () => {
    context("on a live IDE", () => {
        it("exits 0 and prints the in-IDE line", async () => {
            const { code, stdout, stderr } = await run([])
            expect(code).toBe(0)
            expect(stdout).toContain("in a JetBrains IDE terminal")
            expect(stderr).toBe("")
        })

        it("exits 0 and prints nothing under -q", async () => {
            const { code, stdout } = await run(["-q"])
            expect(code).toBe(0)
            expect(stdout).toBe("")
        })

        it("accepts --verbose without crashing", async () => {
            // resolveExecPath may fail when the force-env is set but no real IDE
            // ancestry exists; the verbose path swallows that, so the tool still
            // exits 0. In a real IDE terminal, stderr would contain "in-idea:".
            const { code } = await run(["--verbose"])
            expect(code).toBe(0)
        })

        it("stays silent on stderr without --verbose", async () => {
            const { code, stderr } = await run([])
            expect(code).toBe(0)
            expect(stderr).toBe("")
        })
    })

    context("without a live IDE", () => {
        it("exits 1 and prints the not-in-IDE line", async () => {
            const { code, stdout } = await run([], { PREEMDECK_FORCE_IN_IDEA: "0" })
            expect(code).toBe(1)
            expect(stdout).toContain("not in a JetBrains IDE terminal")
        })

        it("exits 1 and prints nothing under -q", async () => {
            const { code, stdout } = await run(["-q"], { PREEMDECK_FORCE_IN_IDEA: "0" })
            expect(code).toBe(1)
            expect(stdout).toBe("")
        })

        it("exits 1 under cmdore's global --quiet without hijacking the gate", async () => {
            const { code } = await run(["--quiet"], { PREEMDECK_FORCE_IN_IDEA: "0" })
            expect(code).toBe(1)
        })
    })

    context("given malformed arguments", () => {
        it.each([["an unknown flag", ["--bogus"], 'An option "--bogus" is unknown.']] as [
            string,
            string[],
            string
        ][])("exits 2 given %s", async (_label, args, fragment) => {
            const { code, stderr } = await run(args)
            expect(code).toBe(2)
            expect(stderr).toContain(fragment)
        })
    })

    context("with --help", () => {
        it("exits 0 and prints usage to stdout", async () => {
            const { code, stdout } = await run(["--help"])
            expect(code).toBe(0)
            expect(stdout).toContain("in-idea")
        })
    })
})
