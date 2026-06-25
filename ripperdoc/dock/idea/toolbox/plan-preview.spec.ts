import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

const context = describe

/** Spawn the CLI and feed `payload` on stdin (write then end — Bun.spawn rejects a bare string for stdin). */
const run = async (
    payload: string,
    args: string[] = [],
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "plan-preview.ts"), ...args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PREEMDECK_FORCE_IN_IDEA: "1", ...environment }
    })
    subprocess.stdin.write(payload)
    subprocess.stdin.end()
    const [stdout, stderr] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text()
    ])
    const code = await subprocess.exited
    return { code, stdout, stderr }
}

/** The set of `idea-tmp-*` dir names currently in the os tmpdir (writeTemp's mint root). */
const ideaTemps = async (): Promise<Set<string>> => {
    const entries = await fs.readdir(os.tmpdir()).catch(() => [] as string[])
    return new Set(entries.filter((name) => name.startsWith("idea-tmp-")))
}

let directory = ""
let tempsBefore: Set<string>
beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "preemdeck-planpreview-"))
    tempsBefore = await ideaTemps()
})
afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true })
    // The inline-plan path leaks a temp dir (process.exit kills the reap timer);
    // remove whatever appeared during this test so the suite leaves nothing behind.
    const after = await ideaTemps()
    for (const name of after) {
        if (!tempsBefore.has(name)) {
            await fs.rm(path.join(os.tmpdir(), name), { recursive: true, force: true })
        }
    }
})

describe("plan-preview CLI", () => {
    context("on a live IDE", () => {
        it("exits 0 silently for a Claude inline plan under --dry-run", async () => {
            const payload = JSON.stringify({ tool_input: { plan: "# Plan\n\n- step" } })
            const { code, stdout, stderr } = await run(payload, ["--dry-run"])
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })

        it("exits 0 silently for a Gemini plan_path under --dry-run", async () => {
            const planPath = path.join(directory, "plan.md")
            await fs.writeFile(planPath, "# Plan\n")
            const payload = JSON.stringify({ tool_input: { plan_path: planPath } })
            const { code, stdout, stderr } = await run(payload, ["--dry-run"])
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })

        it("accepts plan_path alongside plan and still exits 0 silently", async () => {
            const planPath = path.join(directory, "plan.md")
            await fs.writeFile(planPath, "# Plan\n")
            const payload = JSON.stringify({ tool_input: { plan: "inline", plan_path: planPath } })
            const { code, stdout, stderr } = await run(payload, ["--dry-run"])
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })

        it("accepts and ignores a host-name positional, still exits 0 silently", async () => {
            const payload = JSON.stringify({ tool_input: { plan: "# Plan" } })
            const { code, stdout, stderr } = await run(payload, ["Gemini", "--dry-run"])
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })

        it.each([
            ["empty object", JSON.stringify({})],
            ["empty tool_input", JSON.stringify({ tool_input: {} })],
            ["whitespace plan", JSON.stringify({ tool_input: { plan: "   " } })],
            ["empty plan_path", JSON.stringify({ tool_input: { plan_path: "" } })],
            ["non-string plan", JSON.stringify({ tool_input: { plan: ["not", "a", "str"] } })],
            ["non-object tool_input", JSON.stringify({ tool_input: "not-a-dict" })],
            ["malformed JSON", "not json"],
            ["empty stdin", ""]
        ] as [string, string][])("exits 0 silently on no-plan input (%s)", async (_label, payload) => {
            const { code, stdout, stderr } = await run(payload, ["--dry-run"])
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })
    })

    context("without a live IDE", () => {
        it("exits 0 silently with no open attempted", async () => {
            const payload = JSON.stringify({ tool_input: { plan: "# Plan" } })
            const { code, stdout, stderr } = await run(payload, [], { PREEMDECK_FORCE_IN_IDEA: "0" })
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })
    })

    context("given malformed arguments", () => {
        it.each([["an unknown flag", ["--bogus"], 'An option "--bogus" is unknown.']] as [
            string,
            string[],
            string
        ][])("exits 2 given %s", async (_label, args, fragment) => {
            const payload = JSON.stringify({ tool_input: { plan: "# Plan" } })
            const { code, stderr } = await run(payload, args)
            expect(code).toBe(2)
            expect(stderr).toContain(fragment)
        })
    })

    context("with --help", () => {
        it("exits 0 and prints usage to stdout", async () => {
            const { code, stdout } = await run("", ["--help"])
            expect(code).toBe(0)
            expect(stdout).toContain("plan-preview")
        })
    })
})
