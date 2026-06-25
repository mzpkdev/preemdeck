/**
 * os-ding.spec.ts — exercises os-ding.ts at two layers.
 *
 * UNIT (hermetic, no real audio): the run seam and the platform worker are
 * injected (DI), and the real runCmd seam is exercised against silent
 * subprocesses (MOCK PATTERN D, lightly).
 *
 * E2E (subprocess): spawn os-ding.ts under --dry-run so effect() skips the real
 * spawn — a mechanism is still reported and the process exits 0. Mirrors
 * open-file.spec's subprocess harness.
 */

import { describe, expect, it } from "bun:test"
import * as path from "node:path"
import { ding, dingLinux, dingMacos, LINUX_CANDIDATES, platformWorker, runCmd } from "./os-ding.ts"

const context = describe

// A fake run that records argv and answers per a predicate.
const fakeRun = (ok: (cmd: string[]) => boolean): { calls: string[][]; run: (cmd: string[]) => Promise<boolean> } => {
    const calls: string[][] = []
    return {
        calls,
        run: (cmd: string[]) => {
            calls.push(cmd)
            return Promise.resolve(ok(cmd))
        }
    }
}

// Spawn the CLI as a real subprocess; os-ding takes no positional and ignores stdin.
const run = async (
    args: string[],
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "os-ding.ts"), ...args], {
        stdin: "ignore",
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

describe("os-ding", () => {
    context("runCmd — the real (silent) subprocess seam", () => {
        it("is false for a missing binary", async () => {
            expect(await runCmd(["preemdeck-no-such-binary-zzz"])).toBe(false)
        })
        it("is true for a zero exit", async () => {
            expect(await runCmd(["sh", "-c", "exit 0"])).toBe(true)
        })
        it("is false for a non-zero exit", async () => {
            expect(await runCmd(["sh", "-c", "exit 3"])).toBe(false)
        })
    })

    context("dingMacos — afplay -> osascript -> null", () => {
        it("prefers afplay", async () => {
            const f = fakeRun(() => true)
            expect(await dingMacos(f.run)).toBe("afplay")
            expect(f.calls[0]?.[0]).toBe("afplay")
            expect(f.calls.length).toBe(1)
        })
        it("falls back to osascript", async () => {
            const f = fakeRun((cmd) => cmd[0] === "osascript")
            expect(await dingMacos(f.run)).toBe("osascript")
            expect(f.calls[0]?.[0]).toBe("afplay")
            expect(f.calls.at(-1)?.slice(0, 2)).toEqual(["osascript", "-e"])
        })
        it("is null when all fail", async () => {
            const f = fakeRun(() => false)
            expect(await dingMacos(f.run)).toBeNull()
        })
    })

    context("dingLinux — first installed player wins", () => {
        it("uses the first player that succeeds", async () => {
            const f = fakeRun((cmd) => cmd[0] === "paplay")
            expect(await dingLinux(f.run)).toBe("paplay")
            const tried = f.calls.map((c) => c[0])
            expect(tried[0]).toBe("canberra-gtk-play")
            expect(tried).not.toContain("aplay")
        })
        it("is null when no player works (all candidates tried)", async () => {
            const f = fakeRun(() => false)
            expect(await dingLinux(f.run)).toBeNull()
            expect(f.calls.length).toBe(LINUX_CANDIDATES.length)
        })
    })

    context("ding() — mechanism-or-bell glue", () => {
        it("returns the mechanism and skips the bell", async () => {
            let rang = 0
            expect(
                await ding(
                    async () => "afplay",
                    () => (rang += 1)
                )
            ).toBe("afplay")
            expect(rang).toBe(0)
        })
        it("falls back to the bell exactly once", async () => {
            let rang = 0
            expect(
                await ding(
                    async () => null,
                    () => (rang += 1)
                )
            ).toBe("bell")
            expect(rang).toBe(1)
        })
    })

    context("platformWorker — process.platform dispatch", () => {
        it("dispatches darwin to the macOS worker", async () => {
            const f = fakeRun(() => true)
            expect(await platformWorker("darwin", f.run)()).toBe("afplay")
        })
        it("dispatches linux to the linux worker", async () => {
            const f = fakeRun((cmd) => cmd[0] === "paplay")
            expect(await platformWorker("linux", f.run)()).toBe("paplay")
        })
        it("gives an exotic platform the null worker (straight to bell)", async () => {
            expect(await platformWorker("sunos", fakeRun(() => true).run)()).toBeNull()
        })
    })

    context("as a subprocess", () => {
        it("exits 0 under --dry-run (no real player spawned)", async () => {
            const { code } = await run(["--dry-run"])
            expect(code).toBe(0)
        })

        it("reports the mechanism on stderr under --dry-run --verbose and exits 0", async () => {
            const { code, stderr } = await run(["--dry-run", "--verbose"])
            expect(code).toBe(0)
            expect(stderr).toContain("ding:")
            // A real mechanism fired (not a thrown/empty report), e.g. afplay on a Mac.
            expect(stderr).toMatch(/ding: \S+/)
        })

        it("stays silent without --verbose (no mechanism leaks) and exits 0", async () => {
            const { code, stdout, stderr } = await run(["--dry-run"])
            expect(code).toBe(0)
            expect(stderr).not.toContain("ding:")
            expect(stdout).not.toContain("ding:")
        })

        it("exits 0 and prints usage with --help", async () => {
            const { code, stdout } = await run(["--help"])
            expect(code).toBe(0)
            expect(stdout).toContain("os-ding")
        })

        it("exits 2 on an unknown flag", async () => {
            const { code } = await run(["--bogus"])
            expect(code).toBe(2)
        })
    })
})
