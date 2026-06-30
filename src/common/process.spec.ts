import { describe, expect, it } from "bun:test"
import { PIPED, reap } from "./process"

const context = describe

describe("reap", () => {
    context("when timeoutMs elapses", () => {
        // Drives a real child and asserts wall-clock behavior: reap must KILL the
        // child (not leak it) and return promptly, proving the kill + reap landed.
        it("kills the child (sleep 5 under 200ms) and returns far under its nominal 5s", async () => {
            const started = performance.now()
            const result = await reap(Bun.spawn(["sleep", "5"], PIPED), 200)
            const elapsed = performance.now() - started

            expect(result.timedOut).toBe(true)
            // If the child were NOT killed we'd block ~5000ms; killed + reaped, we return in well under 2s.
            expect(elapsed).toBeLessThan(2000)
            // Killed by signal -> exitCode is null (or non-zero); definitely not a clean 0.
            expect(result.exitCode).not.toBe(0)
        }, 10_000)

        // The actual bug behind the 18-minute /sys:update hang: the child IGNORES
        // SIGTERM and keeps stdout open, so the old reap (SIGTERM + await drain)
        // blocked forever. reap must SIGKILL and race past the stalled drain.
        it("kills a SIGTERM-ignoring child and still returns promptly", async () => {
            const started = performance.now()
            const result = await reap(
                Bun.spawn(["bash", "-c", "trap '' TERM; while true; do sleep 1; done"], PIPED),
                200
            )
            const elapsed = performance.now() - started

            expect(result.timedOut).toBe(true)
            expect(elapsed).toBeLessThan(2000)
        }, 10_000)
    })

    context("draining a child that finishes on its own", () => {
        it("returns exit 0 and captures stdout for a fast command", async () => {
            const result = await reap(Bun.spawn(["printf", "hi"], PIPED), 5000)
            expect(result.timedOut).toBe(false)
            expect(result.exitCode).toBe(0)
            expect(result.stdout).toBe("hi")
        })

        it("captures stderr and a non-zero exit without throwing", async () => {
            const result = await reap(Bun.spawn(["sh", "-c", "printf oops >&2; exit 3"], PIPED))
            expect(result.exitCode).toBe(3)
            expect(result.stderr).toBe("oops")
            expect(result.timedOut).toBe(false)
        })

        it("lets a quick command finish normally when the timeout is omitted/0", async () => {
            const result = await reap(Bun.spawn(["sh", "-c", "exit 0"], PIPED))
            expect(result.timedOut).toBe(false)
            expect(result.exitCode).toBe(0)
        })
    })
})
