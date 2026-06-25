import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

const context = describe

const run = async (
    args: string[],
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "merge-file.ts"), ...args], {
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
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "preemdeck-mergefile-"))
})
afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true })
})

const makeInputs = async (): Promise<{ target: string; suggestion: string; base: string }> => {
    const target = path.join(directory, "target.py")
    const suggestion = path.join(directory, "suggestion.py")
    const base = path.join(directory, "base.py")
    await fs.writeFile(target, "a\n")
    await fs.writeFile(suggestion, "b\n")
    await fs.writeFile(base, "o\n")
    return { target, suggestion, base }
}

describe("merge-file CLI", () => {
    context("on a live IDE", () => {
        it("exits 0 and writes nothing to stdout under --dry-run", async () => {
            const { target, suggestion } = await makeInputs()
            const { code, stdout, stderr } = await run(["--dry-run", target, suggestion])
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })

        it("accepts an optional base positional under --dry-run", async () => {
            const { target, suggestion, base } = await makeInputs()
            const { code, stdout } = await run(["--dry-run", target, suggestion, base])
            expect(code).toBe(0)
            expect(stdout).toBe("")
        })
    })

    context("temp lifecycle", () => {
        it("reaps its spilled temp(s) on the no-wait path", async () => {
            // Inputs are real files; merge-file spills only its internal OUTPUT temp.
            // TMPDIR redirect: os.tmpdir() honors it, so that output temp lands in our
            // hermetic test dir. The reap-aware tail + delay 0 reaps it BEFORE exit.
            const { target, suggestion } = await makeInputs()
            const { code } = await run(["--dry-run", target, suggestion], {
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
            const { target, suggestion } = await makeInputs()
            const { code, stdout, stderr } = await run([target, suggestion], { PREEMDECK_FORCE_IN_IDEA: "0" })
            expect(code).toBe(1)
            expect(stdout).toBe("")
            expect(stderr).toContain("no JetBrains IDE in the process ancestry")
        })

        it("exits 1 when an input path does not exist", async () => {
            const { code, stdout } = await run([path.join(directory, "nope.py"), path.join(directory, "gone.py")])
            expect(code).toBe(1)
            expect(stdout).toBe("")
        })
    })

    context("given malformed arguments", () => {
        it.each([
            ["a missing required suggestion", ["only.txt"], 'An argument "suggestion" is required.'],
            ["an unknown flag", ["--bogus", "a.txt", "b.txt"], 'An option "--bogus" is unknown.']
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
            expect(stdout).toContain("merge-file")
        })
    })
})
