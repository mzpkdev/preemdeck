import { describe, expect, it } from "bun:test"
import * as path from "node:path"
import { firstQuestion } from "./ask-notify"

const context = describe

describe("firstQuestion", () => {
    it("returns the first question's text, cleaned to a gist", () => {
        const input = {
            questions: [
                { question: "Which auth method should we use?", header: "Auth", options: [] },
                { question: "Cache the token?", header: "Cache", options: [] }
            ]
        }
        expect(firstQuestion(input)).toBe("Which auth method should we use?")
    })

    it("strips inline markdown from the question", () => {
        expect(firstQuestion({ questions: [{ question: "Use **Redis** or `Memcached`?" }] })).toBe(
            "Use Redis or Memcached?"
        )
    })

    it.each([
        ["no questions field", {}],
        ["an empty questions array", { questions: [] }],
        ["a non-array questions field", { questions: "nope" }],
        ["a null first entry", { questions: [null] }],
        ["a blank question string", { questions: [{ question: "   " }] }],
        ["a missing question string", { questions: [{ header: "Auth" }] }]
    ] as [string, Record<string, unknown>][])("returns null given %s", (_label, input) => {
        expect(firstQuestion(input)).toBeNull()
    })
})

const run = async (
    args: string[],
    stdin = "",
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "ask-notify.ts"), ...args], {
        stdin: new TextEncoder().encode(stdin),
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

describe("ask-notify CLI", () => {
    context("on a live IDE", () => {
        it("reads an AskUserQuestion payload, exits 0, and writes nothing under --dry-run", async () => {
            const payload = JSON.stringify({
                cwd: "/work/acme",
                tool_input: { questions: [{ question: "Ship it?", header: "Ship", options: [] }] }
            })
            const { code, stdout, stderr } = await run(["--dry-run", "Claude"], payload)
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })

        it("tolerates a payload with no questions and exits 0 under --dry-run", async () => {
            const payload = JSON.stringify({ cwd: "/work/acme", tool_input: {} })
            const { code, stdout } = await run(["--dry-run", "Claude"], payload)
            expect(code).toBe(0)
            expect(stdout).toBe("")
        })

        it("tolerates an empty payload with no host positional and exits 0 under --dry-run", async () => {
            const { code, stdout } = await run(["--dry-run"], "{}")
            expect(code).toBe(0)
            expect(stdout).toBe("")
        })

        it("tolerates absent/blank stdin and exits 0 under --dry-run", async () => {
            const { code, stdout } = await run(["--dry-run", "Claude"], "")
            expect(code).toBe(0)
            expect(stdout).toBe("")
        })
    })

    context("without a live IDE", () => {
        it("stays silent and still exits 0 (a pre-tool hook must never disrupt the host)", async () => {
            const payload = JSON.stringify({ tool_input: { questions: [{ question: "Ship it?" }] } })
            const { code, stdout, stderr } = await run(["Claude"], payload, { PREEMDECK_FORCE_IN_IDEA: "0" })
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
            const { code, stderr } = await run(args, "{}")
            expect(code).toBe(2)
            expect(stderr).toContain(fragment)
        })
    })

    context("with --help", () => {
        it("exits 0 and prints usage to stdout", async () => {
            const { code, stdout } = await run(["--help"], "{}")
            expect(code).toBe(0)
            expect(stdout).toContain("ask-notify")
        })
    })
})
