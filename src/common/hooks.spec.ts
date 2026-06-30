import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sessionKey, throttle } from "./hooks"
import { ENV } from "./preemdeck"

const context = describe

let dir = ""
let restore: PropertyDescriptor | undefined

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "preemdeck-hooks-"))
    // throttle persists counters under ENV.PREEMDECK_ROOT/.state — redirect it at the tmp dir.
    restore = Object.getOwnPropertyDescriptor(ENV, "PREEMDECK_ROOT")
    Object.defineProperty(ENV, "PREEMDECK_ROOT", { configurable: true, get: () => dir })
})
afterEach(async () => {
    if (restore) Object.defineProperty(ENV, "PREEMDECK_ROOT", restore)
    await rm(dir, { recursive: true, force: true })
})

describe("throttle (host-agnostic per-session turn counter)", () => {
    it("fires on turns 1, N+1, 2N+1 as the same session's counter grows", () => {
        const hits: boolean[] = []
        for (let i = 0; i < 7; i++) hits.push(throttle({ session_id: "s" }, 3))
        expect(hits).toEqual([true, false, false, true, false, false, true])
    })

    it("injects on the 1st turn and every 5th with the default cadence", () => {
        const hits: boolean[] = []
        for (let i = 0; i < 11; i++) hits.push(throttle({ session_id: "s" }, 5))
        // turn 1, 6, 11 fire; the rest are no-ops.
        expect(hits).toEqual([true, false, false, false, false, true, false, false, false, false, true])
    })

    it("isolates the counter by session key — two sessions don't share a cadence", () => {
        expect(throttle({ session_id: "a" }, 5)).toBe(true) // a: turn 1
        expect(throttle({ session_id: "a" }, 5)).toBe(false) // a: turn 2
        expect(throttle({ session_id: "b" }, 5)).toBe(true) // b: turn 1, independent
        expect(throttle({ session_id: "a" }, 5)).toBe(false) // a: turn 3
        expect(throttle({ session_id: "b" }, 5)).toBe(false) // b: turn 2
    })

    it("fires every turn when every is 1", () => {
        expect(throttle({ session_id: "s" }, 1)).toBe(true)
        expect(throttle({ session_id: "s" }, 1)).toBe(true)
        expect(throttle({ session_id: "s" }, 1)).toBe(true)
    })

    it("clamps a non-positive cadence to fire-every-turn rather than dividing by zero", () => {
        expect(throttle({ session_id: "s" }, 0)).toBe(true)
        expect(throttle({ session_id: "s" }, 0)).toBe(true)
    })

    it("persists exactly one counter file per session key", async () => {
        throttle({ session_id: "one" }, 5)
        throttle({ session_id: "one" }, 5)
        throttle({ session_id: "two" }, 5)
        const files = await readdir(join(dir, ".state"))
        expect(files).toHaveLength(2)
    })

    context("when no session_id rides the payload", () => {
        it("still increments a stable fallback counter rather than crashing", () => {
            // Same (empty) payload each call → same ppid:cwd fallback key → one growing counter.
            const hits = [throttle({}, 3), throttle({}, 3), throttle({}, 3), throttle({}, 3)]
            expect(hits).toEqual([true, false, false, true])
        })

        it("prefers a *_SESSION_ID env var over the ppid:cwd fallback", () => {
            const saved = process.env.CLAUDE_SESSION_ID
            process.env.CLAUDE_SESSION_ID = "env-session"
            try {
                expect(sessionKey({})).toBe("env-session")
                expect(throttle({}, 5)).toBe(true) // turn 1 for env-session
                expect(throttle({}, 5)).toBe(false) // turn 2, same env key
            } finally {
                if (saved === undefined) delete process.env.CLAUDE_SESSION_ID
                else process.env.CLAUDE_SESSION_ID = saved
            }
        })
    })

    context("deriving the session key", () => {
        it("uses the payload session_id when present", () => {
            expect(sessionKey({ session_id: "abc123" })).toBe("abc123")
        })
        it("ignores a non-string or empty session_id and falls back", () => {
            expect(sessionKey({ session_id: 42 })).toContain("pid:")
            expect(sessionKey({ session_id: "" })).toContain("pid:")
        })
    })
})
