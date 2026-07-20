/**
 * tab-focused.spec.ts — the CLI end-to-end, spawned as a real subprocess.
 *
 * Every non-gate case runs under --dry-run so effect() SKIPS all IDE contact and
 * the command reports the fail-open UNDETERMINED reading: exit 1 (not focused /
 * undetermined) with EXACTLY the JSON verdict line on stdout, and — under
 * --verbose — the parts echoed on stderr. Plus the assertIdea gate: with the
 * JetBrains env cleared and PREEMDECK_FORCE_IN_IDEA=0 the command exits non-zero
 * before any IDE read. Mirrors rename-tab.spec's / tmux-title.spec's harness.
 */

import { describe, expect, it } from "bun:test"
import * as path from "node:path"
import { UNDETERMINED } from "./core"

const context = describe

// The exact stdout line: the JSON verdict the CLI prints + a trailing newline. Built
// from the same UNDETERMINED the CLI reports under --dry-run, so the key order matches.
const VERDICT_LINE = `${JSON.stringify(UNDETERMINED)}\n`

// Spawn the CLI. PREEMDECK_FORCE_IN_IDEA=1 lets assertIdea() pass in CI (outside a
// real IDE); --dry-run makes effect() skip the IDE read.
const run = async (
    args: string[],
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "tab-focused.ts"), ...args], {
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

describe("tab-focused CLI", () => {
    context("on a live IDE, under --dry-run (no IDE contact)", () => {
        it("exits 1 and prints exactly the UNDETERMINED verdict line to stdout", async () => {
            const { code, stdout } = await run(["--dry-run"])
            expect(code).toBe(1) // undetermined counts as NOT focused
            expect(stdout).toBe(VERDICT_LINE)
        })

        it("verdict is the fail-open all-false reading (nothing was read)", async () => {
            const { stdout } = await run(["--dry-run"])
            expect(JSON.parse(stdout.trim())).toEqual(UNDETERMINED)
        })

        it("accepts a session-only tab identity without contacting the IDE", async () => {
            const { code, stdout } = await run(["--dry-run"], {
                TERM_SESSION_ID: "session-42",
                TMUX: ""
            })
            expect(code).toBe(1)
            expect(stdout).toBe(VERDICT_LINE)
        })

        it("stays silent on stderr without --verbose", async () => {
            const { stderr } = await run(["--dry-run"])
            expect(stderr).toBe("")
        })

        it("echoes the parts on stderr under --verbose, stdout still exactly the verdict line", async () => {
            const { code, stdout, stderr } = await run(["--dry-run", "--verbose"])
            expect(code).toBe(1)
            expect(stdout).toBe(VERDICT_LINE) // the parts go to stderr, never polluting stdout
            expect(stderr).toContain("focused=false")
            expect(stderr).toContain("tabSelected=false")
            expect(stderr).toContain("toolWindowActive=false")
            expect(stderr).toContain("frameFocused=false")
        })
    })

    context("the assertIdea gate", () => {
        it("exits non-zero with the IdeaError on stderr when the JetBrains env is unset", async () => {
            const { code, stdout, stderr } = await run(["--dry-run"], {
                __CFBundleIdentifier: "",
                TERMINAL_EMULATOR: "",
                PREEMDECK_FORCE_IN_IDEA: "0"
            })
            expect(code).not.toBe(0)
            expect(stdout).toBe("") // gated out before the verdict is ever printed
            expect(stderr).toContain("no JetBrains IDE in the process ancestry")
        })
    })

    context("with --help", () => {
        it("exits 0 and prints usage to stdout", async () => {
            const { code, stdout } = await run(["--help"])
            expect(code).toBe(0)
            expect(stdout).toContain("tab-focused")
        })
    })
})
