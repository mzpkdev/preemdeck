import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const context = describe

const CLI = join(import.meta.dir, "open-file.ts")
const ORIGINAL = "ORIGINAL\n"

const run = async (
    args: string[],
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, CLI, ...args], {
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
    directory = await mkdtemp(join(tmpdir(), "preemdeck-openfile-"))
})
afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
})

describe("open-file CLI", () => {
    context("on a live IDE", () => {
        it("exits 0 and writes nothing to stdout under --dry-run", async () => {
            const target = join(directory, "thing.py")
            await writeFile(target, ORIGINAL)
            const { code, stdout, stderr } = await run(["--dry-run", target])
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })

        it("prints the file contents back to stdout under --wait", async () => {
            const target = join(directory, "thing.py")
            await writeFile(target, ORIGINAL)
            const { code, stdout } = await run(["--wait", "--dry-run", target])
            expect(code).toBe(0)
            expect(stdout).toBe(ORIGINAL)
        })
    })

    context("without a live IDE", () => {
        it("exits 1 with the IdeaError on stderr", async () => {
            const target = join(directory, "thing.py")
            await writeFile(target, ORIGINAL)
            const { code, stdout, stderr } = await run([target], { PREEMDECK_FORCE_IN_IDEA: "0" })
            expect(code).toBe(1)
            expect(stdout).toBe("")
            expect(stderr).toContain("no JetBrains IDE in the process ancestry")
        })
    })

    context("given malformed arguments", () => {
        it.each([
            ["a non-integer --line", ["--line", "abc", "foo.txt"], "--line must be an integer, got 'abc'"],
            ["an unknown flag", ["--bogus", "foo.txt"], 'An option "--bogus" is unknown.'],
            ["a missing required path", [], 'An argument "path" is required.']
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
            expect(stdout).toContain("open-file")
        })
    })
})
