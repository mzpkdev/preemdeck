import { describe, expect, it } from "bun:test"
import * as path from "node:path"
import { isIdleNotification, notificationMessage } from "./permission-notify"

const context = describe

describe("notificationMessage", () => {
    it("returns the host's message, cleaned to a gist", () => {
        expect(notificationMessage({ message: "Claude needs your permission to use Bash" })).toBe(
            "Claude needs your permission to use Bash"
        )
    })

    it("strips inline markdown from the message", () => {
        expect(notificationMessage({ message: "Allow **Write** to `config.ts`?" })).toBe("Allow Write to config.ts?")
    })

    it.each([
        ["no message field", {}],
        ["a non-string message", { message: 42 }],
        ["a null message", { message: null }],
        ["a blank message string", { message: "   " }]
    ] as [string, Record<string, unknown>][])("returns null given %s", (_label, input) => {
        expect(notificationMessage(input)).toBeNull()
    })
})

describe("isIdleNotification", () => {
    it("is true for the idle 'waiting for your input' ping (case-insensitive)", () => {
        expect(isIdleNotification({ message: "Claude is waiting for your input" })).toBe(true)
        expect(isIdleNotification({ message: "WAITING FOR YOUR INPUT" })).toBe(true)
    })

    it("is false for a permission/access prompt", () => {
        expect(isIdleNotification({ message: "Claude needs your permission to use Bash" })).toBe(false)
    })

    it.each([
        ["no message field", {}],
        ["a non-string message", { message: 42 }]
    ] as [string, Record<string, unknown>][])("is false given %s", (_label, input) => {
        expect(isIdleNotification(input)).toBe(false)
    })
})

const run = async (
    args: string[],
    stdin = "",
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "permission-notify.ts"), ...args], {
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

describe("permission-notify CLI", () => {
    context("on a live IDE", () => {
        it("reads a Notification payload, exits 0, and writes nothing under --dry-run", async () => {
            const payload = JSON.stringify({
                cwd: "/work/acme",
                message: "Claude needs your permission to use Bash"
            })
            const { code, stdout, stderr } = await run(["--dry-run", "Claude"], payload)
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })

        it("tolerates a payload with no message and exits 0 under --dry-run", async () => {
            const payload = JSON.stringify({ cwd: "/work/acme" })
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
        it("stays silent and still exits 0 (a notification hook must never disrupt the host)", async () => {
            const payload = JSON.stringify({ message: "Claude needs your permission to use Bash" })
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
            expect(stdout).toContain("permission-notify")
        })
    })
})
