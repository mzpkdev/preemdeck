import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

const context = describe

const TARGET = "TARGET\n"
const SUGGESTION = "SUGGESTION\n"

const run = async (
    args: string[],
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "diff-file.ts"), ...args], {
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

let directory = ""
beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "preemdeck-difffile-"))
})
afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true })
})

describe("diff-file CLI", () => {
    context("on a live IDE", () => {
        it("exits 0 and writes nothing to stdout under --dry-run", async () => {
            const target = path.join(directory, "target.py")
            const suggestion = path.join(directory, "suggestion.py")
            await fs.writeFile(target, TARGET)
            await fs.writeFile(suggestion, SUGGESTION)
            const { code, stdout, stderr } = await run(["--dry-run", target, suggestion])
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })

        it("prints the LEFT (target) pane back to stdout under --wait", async () => {
            const target = path.join(directory, "target.py")
            const suggestion = path.join(directory, "suggestion.py")
            await fs.writeFile(target, TARGET)
            await fs.writeFile(suggestion, SUGGESTION)
            const { code, stdout } = await run(["--wait", "--dry-run", target, suggestion])
            expect(code).toBe(0)
            expect(stdout).toBe(TARGET)
        })

        it("exits 1 when an input path does not exist", async () => {
            const target = path.join(directory, "target.py")
            await fs.writeFile(target, TARGET)
            const { code, stdout, stderr } = await run(["--dry-run", target, path.join(directory, "nope.py")])
            expect(code).toBe(1)
            expect(stdout).toBe("")
            expect(stderr).not.toBe("")
        })
    })

    context("without a live IDE", () => {
        it("exits 1 with the IdeaError on stderr", async () => {
            const target = path.join(directory, "target.py")
            const suggestion = path.join(directory, "suggestion.py")
            await fs.writeFile(target, TARGET)
            await fs.writeFile(suggestion, SUGGESTION)
            const { code, stdout, stderr } = await run([target, suggestion], { PREEMDECK_FORCE_IN_IDEA: "0" })
            expect(code).toBe(1)
            expect(stdout).toBe("")
            expect(stderr).toContain("no JetBrains IDE in the process ancestry")
        })
    })

    context("given malformed arguments", () => {
        it.each([
            ["a missing required suggestion", ["only.py"], 'An argument "suggestion" is required.'],
            ["an unknown flag", ["--bogus", "a.py", "b.py"], 'An option "--bogus" is unknown.'],
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
            expect(stdout).toContain("diff-file")
        })
    })
})
