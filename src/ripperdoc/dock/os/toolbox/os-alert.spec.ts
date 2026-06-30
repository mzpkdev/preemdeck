/**
 * os-alert.spec.ts — exercises os-alert.ts at two layers.
 *
 * UNIT (hermetic): the pure payload extractor and title builder.
 *
 * E2E (subprocess): spawn os-alert.ts under --dry-run so effect() (inside
 * os-notify) skips the real spawn — a mechanism still "fires", so the process
 * exits 0 and pops nothing. The hook payload rides stdin, as the host delivers it.
 */

import { describe, expect, it } from "bun:test"
import * as path from "node:path"
import { alertTitle, isIdleNotification, notificationMessage } from "./os-alert"

const context = describe

describe("notificationMessage", () => {
    it("returns the host's message text", () => {
        expect(notificationMessage({ message: "Claude needs your permission to use Bash" })).toBe(
            "Claude needs your permission to use Bash"
        )
    })

    it("trims surrounding whitespace", () => {
        expect(notificationMessage({ message: "  needs input  " })).toBe("needs input")
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

describe("alertTitle", () => {
    it("renders '<project> · <host>' when a cwd is known", () => {
        expect(alertTitle("Claude", "/work/acme")).toBe("acme · Claude")
    })

    it.each([
        ["a null cwd", null],
        ["an undefined cwd", undefined],
        ["a root cwd", "/"]
    ] as [string, string | null | undefined][])("falls back to the bare host given %s", (_label, cwd) => {
        expect(alertTitle("Claude", cwd)).toBe("Claude")
    })
})

// Spawn the CLI as a real subprocess. --dry-run keeps every case hermetic: the
// spawn inside os-notify is skipped, so no real banner is ever launched.
const run = async (
    args: string[],
    stdin = "",
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "os-alert.ts"), ...args], {
        stdin: new TextEncoder().encode(stdin),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...environment }
    })
    const [stdout, stderr] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text()
    ])
    const code = await subprocess.exited
    return { code, stdout, stderr }
}

describe("os-alert CLI", () => {
    context("as a subprocess", () => {
        it("reads a Notification payload, exits 0, and writes nothing under --dry-run", async () => {
            const payload = JSON.stringify({ cwd: "/work/acme", message: "Claude needs your permission to use Bash" })
            const { code, stdout, stderr } = await run(["--dry-run", "Claude"], payload)
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })

        it("tolerates a payload with no message and exits 0 under --dry-run", async () => {
            const { code, stdout } = await run(["--dry-run", "Claude"], JSON.stringify({ cwd: "/work/acme" }))
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
            expect(stdout).toContain("os-alert")
        })
    })
})
