/**
 * plan-preview.test.ts — e2e: spawn the CLI as a real subprocess, pipe the hook
 * JSON in on stdin, and assert on its exit code, stdout, and stderr. The real IDE
 * launch is neutralized with --dry-run (cmdore flips effect.enabled off, so the
 * launch/setPreview effects reached through open() are skipped), while stdin
 * parsing, the inIdea gate, the plan/plan_path branching, and the exit code all
 * run for real. PREEMDECK_FORCE_IN_IDEA drives the live-IDE gate.
 *
 * Contract under test: plan-preview is best-effort and SILENT — every input
 * yields exit 0 with empty stdout AND empty stderr (a pre-tool hook must never
 * error or block the host). Only --help breaks the silence, printing usage to
 * stdout (still exit 0).
 *
 * The inline-plan path spills a temp `.md` (writeTemp is unwrapped, so it runs
 * even under --dry-run) and arms a deferred reap; the CLI's process.exit(0) then
 * kills that timer, so the temp leaks. We make this hermetic at the test layer by
 * snapshotting the os-tmpdir `idea-tmp-*` dirs before each test and removing any
 * that appear afterward. The plan_path path opens the file directly and leaks
 * nothing.
 */

import { readdir, rm, writeFile } from "node:fs/promises"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

const CLI = join(import.meta.dir, "plan-preview.ts")

type Result = { code: number; stdout: string; stderr: string }

/** Spawn the CLI and feed `payload` on stdin (write then end — Bun.spawn rejects a bare string for stdin). */
const run = async (payload: string, args: string[] = [], env: Record<string, string> = {}): Promise<Result> => {
    const proc = Bun.spawn([process.execPath, CLI, ...args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PREEMDECK_FORCE_IN_IDEA: "1", ...env }
    })
    proc.stdin.write(payload)
    proc.stdin.end()
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const code = await proc.exited
    return { code, stdout, stderr }
}

/** The set of `idea-tmp-*` dir names currently in the os tmpdir (writeTemp's mint root). */
const ideaTemps = async (): Promise<Set<string>> => {
    const entries = await readdir(tmpdir()).catch(() => [] as string[])
    return new Set(entries.filter((name) => name.startsWith("idea-tmp-")))
}

let dir = ""
let tempsBefore: Set<string>
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "preemdeck-planpreview-"))
    tempsBefore = await ideaTemps()
})
afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    // The inline-plan path leaks a temp dir (process.exit kills the reap timer);
    // remove whatever appeared during this test so the suite leaves nothing behind.
    const after = await ideaTemps()
    for (const name of after) {
        if (!tempsBefore.has(name)) {
            await rm(join(tmpdir(), name), { recursive: true, force: true })
        }
    }
})

describe("plan-preview CLI", () => {
    test("Claude inline plan exits 0, silently (launch skipped under --dry-run)", async () => {
        const payload = JSON.stringify({ tool_input: { plan: "# Plan\n\n- step" } })
        const { code, stdout, stderr } = await run(payload, ["--dry-run"])
        expect(code).toBe(0)
        expect(stdout).toBe("")
        expect(stderr).toBe("")
    })

    test("Gemini plan_path exits 0, silently", async () => {
        const planPath = join(dir, "plan.md")
        await writeFile(planPath, "# Plan\n")
        const payload = JSON.stringify({ tool_input: { plan_path: planPath } })
        const { code, stdout, stderr } = await run(payload, ["--dry-run"])
        expect(code).toBe(0)
        expect(stdout).toBe("")
        expect(stderr).toBe("")
    })

    test("plan_path is accepted alongside plan and still exits 0 silently", async () => {
        const planPath = join(dir, "plan.md")
        await writeFile(planPath, "# Plan\n")
        const payload = JSON.stringify({ tool_input: { plan: "inline", plan_path: planPath } })
        const { code, stdout, stderr } = await run(payload, ["--dry-run"])
        expect(code).toBe(0)
        expect(stdout).toBe("")
        expect(stderr).toBe("")
    })

    test.each([
        ["empty object", JSON.stringify({})],
        ["empty tool_input", JSON.stringify({ tool_input: {} })],
        ["whitespace plan", JSON.stringify({ tool_input: { plan: "   " } })],
        ["empty plan_path", JSON.stringify({ tool_input: { plan_path: "" } })],
        ["non-string plan", JSON.stringify({ tool_input: { plan: ["not", "a", "str"] } })],
        ["non-object tool_input", JSON.stringify({ tool_input: "not-a-dict" })],
        ["malformed JSON", "not json"],
        ["empty stdin", ""]
    ])("no-plan input (%s) exits 0, silently", async (_label, payload) => {
        const { code, stdout, stderr } = await run(payload, ["--dry-run"])
        expect(code).toBe(0)
        expect(stdout).toBe("")
        expect(stderr).toBe("")
    })

    test("host-name positional is accepted and ignored, still exits 0 silently", async () => {
        const payload = JSON.stringify({ tool_input: { plan: "# Plan" } })
        const { code, stdout, stderr } = await run(payload, ["Gemini", "--dry-run"])
        expect(code).toBe(0)
        expect(stdout).toBe("")
        expect(stderr).toBe("")
    })

    test("gate: no live IDE exits 0 silently (no open attempted)", async () => {
        const payload = JSON.stringify({ tool_input: { plan: "# Plan" } })
        const { code, stdout, stderr } = await run(payload, [], { PREEMDECK_FORCE_IN_IDEA: "0" })
        expect(code).toBe(0)
        expect(stdout).toBe("")
        expect(stderr).toBe("")
    })

    test("a cmdore parse failure is swallowed: unknown flag still exits 0 silently", async () => {
        const payload = JSON.stringify({ tool_input: { plan: "# Plan" } })
        const { code, stdout, stderr } = await run(payload, ["--bogus"])
        expect(code).toBe(0)
        expect(stdout).toBe("")
        expect(stderr).toBe("")
    })

    test("--help exits 0 and prints usage to stdout", async () => {
        const { code, stdout } = await run("", ["--help"])
        expect(code).toBe(0)
        expect(stdout).toContain("plan-preview")
    })
})
