/**
 * os-ding.test.ts — exercises os-ding.ts. Hermetic: no real audio. The run
 * seam and the platform worker are injected (DI), and the real runCmd seam is
 * exercised against silent subprocesses (MOCK PATTERN D, lightly).
 */

import { describe, expect, test } from "bun:test"
import { ding, dingLinux, dingMacos, LINUX_CANDIDATES, platformWorker, runCmd } from "./os-ding.ts"

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

describe("runCmd — the real (silent) subprocess seam", () => {
    test("false for a missing binary", async () => {
        expect(await runCmd(["preemdeck-no-such-binary-zzz"])).toBe(false)
    })
    test("true for a zero exit", async () => {
        expect(await runCmd(["sh", "-c", "exit 0"])).toBe(true)
    })
    test("false for a non-zero exit", async () => {
        expect(await runCmd(["sh", "-c", "exit 3"])).toBe(false)
    })
})

describe("dingMacos — afplay -> osascript -> null", () => {
    test("prefers afplay", async () => {
        const f = fakeRun(() => true)
        expect(await dingMacos(f.run)).toBe("afplay")
        expect(f.calls[0]?.[0]).toBe("afplay")
        expect(f.calls.length).toBe(1)
    })
    test("falls back to osascript", async () => {
        const f = fakeRun((cmd) => cmd[0] === "osascript")
        expect(await dingMacos(f.run)).toBe("osascript")
        expect(f.calls[0]?.[0]).toBe("afplay")
        expect(f.calls.at(-1)?.slice(0, 2)).toEqual(["osascript", "-e"])
    })
    test("null when all fail", async () => {
        const f = fakeRun(() => false)
        expect(await dingMacos(f.run)).toBeNull()
    })
})

describe("dingLinux — first installed player wins", () => {
    test("uses the first player that succeeds", async () => {
        const f = fakeRun((cmd) => cmd[0] === "paplay")
        expect(await dingLinux(f.run)).toBe("paplay")
        const tried = f.calls.map((c) => c[0])
        expect(tried[0]).toBe("canberra-gtk-play")
        expect(tried).not.toContain("aplay")
    })
    test("null when no player works (all candidates tried)", async () => {
        const f = fakeRun(() => false)
        expect(await dingLinux(f.run)).toBeNull()
        expect(f.calls.length).toBe(LINUX_CANDIDATES.length)
    })
})

describe("ding() — mechanism-or-bell glue", () => {
    test("returns the mechanism and skips the bell", async () => {
        let rang = 0
        expect(
            await ding(
                async () => "afplay",
                () => (rang += 1)
            )
        ).toBe("afplay")
        expect(rang).toBe(0)
    })
    test("falls back to the bell exactly once", async () => {
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

describe("platformWorker — sys.platform dispatch", () => {
    test("darwin -> macOS worker", async () => {
        const f = fakeRun(() => true)
        expect(await platformWorker("darwin", f.run)()).toBe("afplay")
    })
    test("linux -> linux worker", async () => {
        const f = fakeRun((cmd) => cmd[0] === "paplay")
        expect(await platformWorker("linux", f.run)()).toBe("paplay")
    })
    test("an exotic platform -> null worker (straight to bell)", async () => {
        expect(await platformWorker("sunos", fakeRun(() => true).run)()).toBeNull()
    })
})
