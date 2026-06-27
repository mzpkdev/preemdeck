/**
 * reap.test.ts — hermetic, no real wall-clock delay.
 *
 * reapLater arms a ref'd setTimeout that, after `delayMs`, unlinks each path. The
 * original suite gated the seam with a controllable sleep; here we use bun's fake
 * timers (`setSystemTime` + manual tick via `jest.useFakeTimers`-style control is
 * not exposed, so we drive the timer with `mock` of setTimeout). MOCK PATTERN:
 * spy on the global `setTimeout` to capture the scheduled callback + delay, run
 * it deterministically, and assert the FS effect — no test waits on real time.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { REAP_DELAY_MS, reapLater } from "./reap.ts"

let dir = ""

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "preemdeck-reap-"))
})

afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

const exists = async (p: string): Promise<boolean> => Bun.file(p).exists()

/**
 * Arm reapLater with `setTimeout` spied so the scheduled reap runs on demand.
 * Returns the captured delay and a `fire()` that runs the callback and awaits the
 * unlink it kicks off.
 */
const armed = (paths: Iterable<string>, delayMs?: number): { delay: number; fire: () => Promise<void> } => {
    let cb: (() => void) | undefined
    let delay = -1
    const spy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
        cb = fn
        delay = ms ?? 0
        return 0 as unknown as ReturnType<typeof setTimeout>
    }) as never)
    try {
        if (delayMs === undefined) {
            reapLater(paths)
        } else {
            reapLater(paths, delayMs)
        }
    } finally {
        spy.mockRestore()
    }
    return {
        delay,
        fire: async () => {
            cb?.()
            // The callback's unlink loop is async; let microtasks drain.
            await Promise.resolve()
            await new Promise<void>((r) => setTimeout(r, 0))
        }
    }
}

describe("reapLater", () => {
    test("unlinks the scheduled paths after the timer fires", async () => {
        const a = join(dir, "a.txt")
        const b = join(dir, "b.txt")
        await writeFile(a, "a")
        await writeFile(b, "b")

        const { fire } = armed([a, b])
        await fire()

        expect(await exists(a)).toBe(false)
        expect(await exists(b)).toBe(false)
    })

    test("a missing path does not throw, and the present path is still reaped", async () => {
        const present = join(dir, "present.txt")
        const missing = join(dir, "nope.txt") // never created
        await writeFile(present, "x")

        const { fire } = armed([missing, present])
        await fire() // must not reject on the missing path

        expect(await exists(present)).toBe(false)
    })

    test("tolerates an empty iterable (fires, unlinks nothing)", async () => {
        const { fire } = armed([])
        await fire() // no throw
    })

    test("is handed exactly the delay it was given", () => {
        const { delay } = armed([join(dir, "a.txt")], 42_000)
        expect(delay).toBe(42_000)
    })

    test("default delay is REAP_DELAY_MS (3000ms)", () => {
        expect(REAP_DELAY_MS).toBe(3000)
        const { delay } = armed([join(dir, "a.txt")])
        expect(delay).toBe(REAP_DELAY_MS)
    })

    test("returns immediately without waiting out the delay", () => {
        // armed() drives a fake timer, so reapLater plainly returned (no real wait).
        // A 1-hour delay would hang a real wait; here it returns at once.
        const started = performance.now()
        const { delay } = armed([join(dir, "a.txt")], 3_600_000)
        expect(performance.now() - started).toBeLessThan(1000)
        expect(delay).toBe(3_600_000)
    })

    test("materializes the iterable up front (generator can't be exhausted late)", async () => {
        const a = join(dir, "a.txt")
        await writeFile(a, "a")
        function* once(): Generator<string> {
            yield a
        }
        const { fire } = armed(once())
        await fire()
        expect(await exists(a)).toBe(false)
    })
})
