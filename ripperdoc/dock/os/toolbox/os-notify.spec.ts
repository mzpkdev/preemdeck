/**
 * os-notify.spec.ts — exercises os-notify.ts at two layers.
 *
 * UNIT (hermetic, no real banners): the run seam (with env), the terminal-notifier
 * presence check, and the platform worker are injected (DI). The no-injection
 * contract — user text rides env/argv, never the script source — is asserted
 * explicitly, including hostile text, and the AppleScript is verified static.
 *
 * E2E (subprocess): spawn os-notify.ts under --dry-run so effect() skips the real
 * spawn — the first mechanism still "fires", so a mechanism is reported and the
 * process exits 0. Mirrors open-file.spec's subprocess harness. The no-mechanism
 * -> exit-1 path can't be forced via dry-run (a mechanism always fires), so it
 * stays covered by the notify()-returns-null unit below.
 */

import { describe, expect, it } from "bun:test"
import * as path from "node:path"
import { MACOS_APPLESCRIPT, notify, notifyLinux, notifyMacos, platformWorker, runCmd } from "./os-notify.ts"

const context = describe

type RunCall = {
    cmd: string[]
    env: Record<string, string> | undefined
}

// A fake run that records argv + env and answers per a fixed value or predicate.
const fakeRun = (
    ok: boolean | ((cmd: string[]) => boolean)
): {
    calls: RunCall[]
    run: (cmd: string[], env?: Record<string, string>) => Promise<boolean>
} => {
    const calls: RunCall[] = []
    const answer = typeof ok === "function" ? ok : () => ok
    return {
        calls,
        run: (cmd: string[], env?: Record<string, string>) => {
            calls.push({ cmd, env })
            return Promise.resolve(answer(cmd))
        }
    }
}

// Spawn the CLI as a real subprocess. --dry-run keeps every case hermetic: the
// spawn is skipped, so no real notifier is ever launched.
const run = async (
    args: string[],
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "os-notify.ts"), ...args], {
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

describe("os-notify", () => {
    context("runCmd — the real (silent) subprocess seam", () => {
        it("is false for a missing binary", async () => {
            expect(await runCmd(["preemdeck-no-such-binary-zzz"])).toBe(false)
        })
        it("merges env over the inherited environment (var reaches child)", async () => {
            const code = 'exit $([ "$PD_NOTIFY_TITLE" = X ] && echo 0 || echo 7)'
            expect(await runCmd(["sh", "-c", code], { PD_NOTIFY_TITLE: "X" })).toBe(true)
        })
        it("keeps the inherited env (PATH survives the merge)", async () => {
            const code = 'exit $([ -n "$PATH" ] && echo 0 || echo 7)'
            expect(await runCmd(["sh", "-c", code], { PD_NOTIFY_TITLE: "X" })).toBe(true)
        })
    })

    context("notifyMacos — osascript (env-fed) / terminal-notifier (argv)", () => {
        it("uses osascript with the static script when terminal-notifier is absent", async () => {
            const f = fakeRun(true)
            expect(await notifyMacos("hello", "CI", { run: f.run, has: () => false })).toBe("osascript")
            expect(f.calls[0]?.cmd).toEqual(["osascript", "-e", MACOS_APPLESCRIPT])
            expect(f.calls[0]?.env).toEqual({ PD_NOTIFY_TITLE: "CI", PD_NOTIFY_MESSAGE: "hello" })
        })

        it("is null when both fail", async () => {
            const f = fakeRun(false)
            expect(await notifyMacos("hello", "CI", { run: f.run, has: () => false })).toBeNull()
        })

        it("prefers terminal-notifier when present (title/body as argv, no env)", async () => {
            const f = fakeRun(true)
            expect(await notifyMacos("hello", "CI", { run: f.run, has: () => true })).toBe("terminal-notifier")
            expect(f.calls[0]?.cmd).toEqual(["terminal-notifier", "-title", "CI", "-message", "hello"])
            expect(f.calls[0]?.env).toBeUndefined()
        })

        it("falls back: terminal-notifier installed but errors -> osascript fires", async () => {
            const f = fakeRun((cmd) => cmd[0] !== "terminal-notifier")
            expect(await notifyMacos("hello", "CI", { run: f.run, has: () => true })).toBe("osascript")
            expect(f.calls.map((c) => c.cmd[0])).toEqual(["terminal-notifier", "osascript"])
        })

        it("keeps terminal-notifier hostile text as argv (never a script)", async () => {
            const f = fakeRun(true)
            const nasty = '"; rm -rf / #'
            await notifyMacos(nasty, 'ti"tle', { run: f.run, has: () => true })
            expect(f.calls[0]?.cmd).toEqual(["terminal-notifier", "-title", 'ti"tle', "-message", nasty])
            expect(f.calls[0]?.env).toBeUndefined()
        })
    })

    context("notifyLinux — notify-send, title/body as argv", () => {
        it("passes title and body as argv", async () => {
            const f = fakeRun(true)
            expect(await notifyLinux("body text", "Heads up", f.run)).toBe("notify-send")
            expect(f.calls[0]?.cmd).toEqual(["notify-send", "Heads up", "body text"])
            expect(f.calls[0]?.env).toBeUndefined()
        })
        it("is null on failure", async () => {
            const f = fakeRun(false)
            expect(await notifyLinux("body", "title", f.run)).toBeNull()
        })
        it("keeps hostile text a single argv element", async () => {
            const f = fakeRun(true)
            const nasty = "$(rm -rf /); `whoami`"
            await notifyLinux(nasty, "title", f.run)
            expect(f.calls[0]?.cmd).toEqual(["notify-send", "title", nasty])
        })
    })

    context("the no-injection contract", () => {
        it("keeps the AppleScript static, reading both fields from the environment", () => {
            expect(MACOS_APPLESCRIPT).toContain("system attribute")
            expect(MACOS_APPLESCRIPT).toContain("PD_NOTIFY_MESSAGE")
            expect(MACOS_APPLESCRIPT).toContain("PD_NOTIFY_TITLE")
        })
        it("never lets macOS hostile text enter the script (only env)", async () => {
            const f = fakeRun(true)
            const nasty = '"; do shell script "rm -rf /"\n'
            await notifyMacos(nasty, 'ti"tle', { run: f.run, has: () => false })
            expect(f.calls[0]?.cmd).toEqual(["osascript", "-e", MACOS_APPLESCRIPT])
            expect(f.calls[0]?.env).toEqual({ PD_NOTIFY_TITLE: 'ti"tle', PD_NOTIFY_MESSAGE: nasty })
        })
    })

    context("notify() — mechanism-or-null glue (platform-independent)", () => {
        it("returns the worker's mechanism and threads message/title", async () => {
            const seen: [string, string][] = []
            const worker = async (message: string, title: string) => {
                seen.push([message, title])
                return "osascript"
            }
            expect(await notify("hi", "T", worker)).toBe("osascript")
            expect(seen).toEqual([["hi", "T"]])
        })
        it("returns null when the worker has no mechanism (the exit-1 floor)", async () => {
            expect(await notify("hi", "PreemDeck", async () => null)).toBeNull()
        })
        it("defaults the title to PreemDeck", async () => {
            const seen: [string, string][] = []
            await notify("hi", undefined, async (message, title) => {
                seen.push([message, title])
                return null
            })
            expect(seen).toEqual([["hi", "PreemDeck"]])
        })
    })

    context("platformWorker — process.platform dispatch", () => {
        it("gives an exotic platform the null worker (no desktop notifier)", async () => {
            expect(await platformWorker("sunos")("m", "t")).toBeNull()
        })
    })

    context("as a subprocess", () => {
        it("exits 0 under --dry-run (no real notifier spawned)", async () => {
            const { code } = await run(["--dry-run", "hello"])
            expect(code).toBe(0)
        })

        it("reports the mechanism on stderr under --dry-run --verbose and exits 0", async () => {
            const { code, stderr } = await run(["--dry-run", "--verbose", "hello"])
            expect(code).toBe(0)
            expect(stderr).toContain("notify:")
            // A real mechanism fired (e.g. osascript on a Mac), not an empty report.
            expect(stderr).toMatch(/notify: \S+/)
        })

        it("stays silent without --verbose (no mechanism leaks) and exits 0", async () => {
            const { code, stdout, stderr } = await run(["--dry-run", "hello"])
            expect(code).toBe(0)
            expect(stderr).not.toContain("notify:")
            expect(stdout).not.toContain("notify:")
        })

        it("accepts --title and exits 0 under --dry-run", async () => {
            const { code } = await run(["--title", "T", "--dry-run", "hi"])
            expect(code).toBe(0)
        })

        it.each([
            ["a missing message", [] as string[], 'An argument "message" is required.'],
            ["two positionals", ["one", "two"], "expected a single message argument"],
            ["an unknown flag", ["--bogus", "hi"], 'An option "--bogus" is unknown.']
        ] as [string, string[], string][])("exits 2 given %s", async (_label, args, fragment) => {
            const { code, stderr } = await run(args)
            expect(code).toBe(2)
            expect(stderr).toContain(fragment)
        })

        it("exits 0 and prints usage with --help", async () => {
            const { code, stdout } = await run(["--help"])
            expect(code).toBe(0)
            expect(stdout).toContain("os-notify")
        })
    })
})
