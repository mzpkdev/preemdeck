import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { htmlEscape, subagentsPending } from "./turn-notify"

const context = describe

describe("htmlEscape", () => {
    it("escapes the five quote-mode characters", () => {
        // The golden value for htmlEscape('<a href="x">&\'</a>').
        expect(htmlEscape('<a href="x">&\'</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#x27;&lt;/a&gt;")
    })

    it("ampersand is escaped first, so entities are not double-escaped", () => {
        expect(htmlEscape("a & b")).toBe("a &amp; b")
        expect(htmlEscape("<")).toBe("&lt;") // not &amp;lt;
    })

    it("leaves plain text untouched", () => {
        expect(htmlEscape("Claude finished responding")).toBe("Claude finished responding")
    })
})

const run = async (
    args: string[],
    stdin = "",
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "turn-notify.ts"), ...args], {
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

describe("turn-notify CLI", () => {
    context("on a live IDE", () => {
        it("reads a Claude payload, exits 0, and writes nothing to stdout under --dry-run", async () => {
            const payload = JSON.stringify({ cwd: "/work/acme", last_assistant_message: "Probed the hook." })
            const { code, stdout, stderr } = await run(["--dry-run", "Claude"], payload)
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })

        it("reads a Gemini prompt_response payload and exits 0 under --dry-run", async () => {
            const payload = JSON.stringify({ cwd: "/work/acme", prompt_response: "Converted to async/await." })
            const { code, stdout } = await run(["--dry-run", "Gemini"], payload)
            expect(code).toBe(0)
            expect(stdout).toBe("")
        })

        it("tolerates a tool-only turn (null message) and exits 0 under --dry-run", async () => {
            const payload = JSON.stringify({ cwd: "/work/acme", last_assistant_message: null })
            const { code, stdout } = await run(["--dry-run", "Codex"], payload)
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
        it("stays silent and still exits 0 (a turn-end hook must never disrupt the host)", async () => {
            const payload = JSON.stringify({ cwd: "/work/acme", prompt_response: "done" })
            const { code, stdout, stderr } = await run(["Gemini"], payload, { PREEMDECK_FORCE_IN_IDEA: "0" })
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
            expect(stdout).toContain("turn-notify")
        })
    })
})

describe("subagentsPending (interim-turn gate)", () => {
    let dir = ""
    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), "preemdeck-turnnotify-"))
    })
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true })
    })

    const write = async (entries: object[]): Promise<string> => {
        const p = path.join(dir, "transcript.jsonl")
        await writeFile(p, entries.map((e) => JSON.stringify(e)).join("\n"))
        return p
    }
    const prompt = { type: "user", message: { content: "do the thing" } }
    const spawn = (id: string): object => ({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Agent", id }] }
    })
    const result = (id: string): object => ({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: id }] }
    })
    const text = { type: "assistant", message: { content: [{ type: "text" }] } }

    it("is true while a spawned Agent has no result (interim turn)", async () => {
        expect(await subagentsPending(await write([prompt, spawn("a1")]))).toBe(true)
    })

    it("is false once every Agent has resolved (final turn)", async () => {
        const t = await write([prompt, spawn("a1"), spawn("a2"), result("a1"), result("a2")])
        expect(await subagentsPending(t)).toBe(false)
    })

    it("is false for a turn that spawned no subagents", async () => {
        expect(await subagentsPending(await write([prompt, text]))).toBe(false)
    })

    it("ignores agents from a prior turn (scopes to the last prompt)", async () => {
        expect(await subagentsPending(await write([prompt, spawn("old"), prompt, text]))).toBe(false)
    })

    it("is false (fires the notify) for a missing transcript", async () => {
        expect(await subagentsPending(path.join(dir, "nope.jsonl"))).toBe(false)
    })
})
