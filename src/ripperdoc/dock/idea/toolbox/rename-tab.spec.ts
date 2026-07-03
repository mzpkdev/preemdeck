/**
 * rename-tab.spec.ts — the CLI end-to-end, spawned as a real subprocess.
 *
 * Every case runs under --dry-run so effect() resolves the tab's pids but SKIPS
 * the real IDE dispatch (no launcher is ever spawned). We assert the exit code,
 * clean stdout, and the --verbose decision line on stderr for each name mode:
 * a real name (rename), --reset / blank / omitted (reset), plus the assertIdea
 * gate — with the JetBrains env cleared the command exits non-zero before any
 * pid work. Mirrors notify.spec's / tmux-title.spec's subprocess harness.
 */

import { describe, expect, it } from "bun:test"
import * as path from "node:path"

const context = describe

// Spawn the CLI. PREEMDECK_FORCE_IN_IDEA=1 lets assertIdea() pass in CI (outside a
// real IDE); --dry-run makes effect() skip the IDE write.
const run = async (
    args: string[],
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "rename-tab.ts"), ...args], {
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

describe("rename-tab CLI", () => {
    context("on a live IDE, under --dry-run (no IDE write)", () => {
        it("takes the rename path for a real name: exits 0, stdout empty", async () => {
            const { code, stdout } = await run(["--dry-run", "PR review"])
            expect(code).toBe(0)
            expect(stdout).toBe("")
        })

        it("stays silent on stderr without --verbose", async () => {
            const { code, stderr } = await run(["--dry-run", "PR review"])
            expect(code).toBe(0)
            expect(stderr).toBe("")
        })

        it("reports the rename decision on stderr under --verbose", async () => {
            const { code, stderr } = await run(["--dry-run", "--verbose", "PR review"])
            expect(code).toBe(0)
            expect(stderr).toContain("name=PR review")
        })

        it.each([
            ["--reset flag", ["--dry-run", "--verbose", "--reset"]],
            ["an omitted name", ["--dry-run", "--verbose"]]
        ] as [string, string[]][])("takes the reset path for %s", async (_label, args) => {
            const { code, stderr } = await run(args)
            expect(code).toBe(0)
            expect(stderr).toContain("reset (restore auto-naming)")
        })

        it.each([
            ["--reset", ["--dry-run", "--reset"]],
            ["a blank name", ["--dry-run", ""]],
            ["an omitted name", ["--dry-run"]]
        ] as [string, string[]][])("exits 0 with empty stdout for %s", async (_label, args) => {
            const { code, stdout } = await run(args)
            expect(code).toBe(0)
            expect(stdout).toBe("")
        })
    })

    context("the assertIdea gate", () => {
        it("exits non-zero with the IdeaError on stderr when the JetBrains env is unset", async () => {
            const { code, stdout, stderr } = await run(["--dry-run", "PR review"], {
                __CFBundleIdentifier: "",
                TERMINAL_EMULATOR: "",
                PREEMDECK_FORCE_IN_IDEA: "0"
            })
            expect(code).not.toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toContain("no JetBrains IDE in the process ancestry")
        })
    })

    context("with --help", () => {
        it("exits 0 and prints usage to stdout", async () => {
            const { code, stdout } = await run(["--help"])
            expect(code).toBe(0)
            expect(stdout).toContain("rename-tab")
        })
    })
})
