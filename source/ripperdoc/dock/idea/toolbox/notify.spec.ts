import { describe, expect, it } from "bun:test"
import * as path from "node:path"

const context = describe

const run = async (
    args: string[],
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "notify.ts"), ...args], {
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

describe("notify CLI", () => {
    context("on a live IDE", () => {
        it("exits 0 and writes nothing to stdout under --dry-run", async () => {
            const { code, stdout, stderr } = await run(["--dry-run", "build finished"])
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })

        it("threads --title and exits 0 under --dry-run", async () => {
            const { code, stdout } = await run(["--dry-run", "--title", "CI", "tests failed"])
            expect(code).toBe(0)
            expect(stdout).toBe("")
        })

        it.each([["info"], ["warning"], ["error"]] as [
            string
        ][])("accepts --type %s and exits 0 under --dry-run", async (kind) => {
            const { code } = await run(["--dry-run", "--type", kind, "a message"])
            expect(code).toBe(0)
        })

        it.each([
            ["open-url", ["--action", "open-url=https://example.com"]],
            ["open-file", ["--action", "open-file=/tmp/build.log"]],
            ["open-preview", ["--action", "open-preview=http://localhost:3000"]]
        ] as [string, string[]][])("accepts a vetted --action %s and exits 0 under --dry-run", async (_label, flag) => {
            const { code } = await run(["--dry-run", "a message", ...flag])
            expect(code).toBe(0)
        })

        it("accepts repeated --action flags and exits 0 under --dry-run", async () => {
            const { code } = await run([
                "--dry-run",
                "a message",
                "--action",
                "open-preview=https://x",
                "--action",
                "open-file=/tmp"
            ])
            expect(code).toBe(0)
        })

        it("accepts --all and exits 0 under --dry-run", async () => {
            const { code, stdout, stderr } = await run(["--dry-run", "--all", "a message"])
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })
    })

    context("without a live IDE", () => {
        it("exits 1 with the IdeaError on stderr, even with actions", async () => {
            const { code, stdout, stderr } = await run(["a message", "--action", "open-url=https://example.com"], {
                PREEMDECK_FORCE_IN_IDEA: "0"
            })
            expect(code).toBe(1)
            expect(stdout).toBe("")
            expect(stderr).toContain("no JetBrains IDE in the process ancestry")
        })
    })

    context("given malformed arguments", () => {
        it.each([
            ["a missing required message", [], 'An argument "message" is required.'],
            ["an unknown flag", ["--bogus", "a message"], 'An option "--bogus" is unknown.'],
            ["an off-whitelist --type", ["--type", "fatal", "a message"], "--type: invalid choice: 'fatal'"],
            [
                "an unknown --action",
                ["--action", "open-everything=x", "a message"],
                "--action: unknown action 'open-everything'"
            ],
            [
                "an --action missing its required arg",
                ["--action", "open-url", "a message"],
                "--action: action 'open-url' needs an argument"
            ]
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
            expect(stdout).toContain("notify")
        })
    })
})
