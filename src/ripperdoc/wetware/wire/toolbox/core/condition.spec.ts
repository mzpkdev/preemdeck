import { describe, expect, it } from "bun:test"
import { type Condition, makeCondition } from "./condition"

const context = describe

/** Yield to the macrotask queue so any pending 0ms timer / notify settles. */
const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0))

/**
 * A flippable predicate paired with the condition that re-tests it: `flip()`
 * sets the flag true and notifies, modelling a write that satisfies a waiter.
 */
const flag = (cond: Condition): { ready: () => boolean; flip: () => void } => {
    let value = false
    return {
        ready: () => value,
        flip: () => {
            value = true
            cond.notifyAll()
        }
    }
}

describe("makeCondition", () => {
    context("when the predicate is already true", () => {
        it("resolves true immediately, with no notify needed", async () => {
            const cond = makeCondition()
            await expect(cond.waitFor(() => true, 1000)).resolves.toBe(true)
        })
    })

    context("when notified after parking", () => {
        it("wakes and resolves true once the predicate flips", async () => {
            const cond = makeCondition()
            const f = flag(cond)
            const parked = cond.waitFor(f.ready, 1000)
            await tick() // ensure we are parked before the flip
            f.flip()
            await expect(parked).resolves.toBe(true)
        })
    })

    context("when nothing satisfies the predicate", () => {
        it("resolves false on timeout", async () => {
            const cond = makeCondition()
            await expect(cond.waitFor(() => false, 5)).resolves.toBe(false)
        })
    })

    context("when a notify arrives but the predicate is still false", () => {
        it("keeps waiting (spurious wake), then times out false", async () => {
            const cond = makeCondition()
            let resolved: boolean | undefined
            const parked = cond
                .waitFor(() => false, 1000)
                .then((v) => {
                    resolved = v
                })
            await tick()
            cond.notifyAll() // non-satisfying wake
            cond.notifyAll()
            await tick()
            expect(resolved).toBeUndefined() // still parked despite the notifies
            await parked
            expect(resolved).toBe(false) // only the timeout resolves it
        })
    })

    context("with multiple waiters", () => {
        it("re-checks every waiter on a single notifyAll", async () => {
            const cond = makeCondition()
            const f = flag(cond)
            const a = cond.waitFor(f.ready, 1000)
            const b = cond.waitFor(f.ready, 1000)
            const c = cond.waitFor(f.ready, 1000)
            await tick()
            f.flip() // one notify must wake all three
            await expect(Promise.all([a, b, c])).resolves.toEqual([true, true, true])
        })

        it("resolves only the waiters whose predicate is satisfied", async () => {
            const cond = makeCondition()
            let satisfied = false
            const ready = () => satisfied
            const winner = cond.waitFor(ready, 1000)
            let loserResolved: boolean | undefined
            const loser = cond
                .waitFor(() => false, 1000)
                .then((v) => {
                    loserResolved = v
                })
            await tick()
            satisfied = true
            cond.notifyAll()
            await expect(winner).resolves.toBe(true)
            expect(loserResolved).toBeUndefined() // the never-satisfied waiter stays parked
            await loser
            expect(loserResolved).toBe(false)
        })
    })

    context("when a notify races the await (notify-before-park window)", () => {
        it("is not lost — registration happens before yielding to the loop", async () => {
            const cond = makeCondition()
            let value = false
            // Fire notifies synchronously right after waitFor returns its promise,
            // before any microtask boundary. The waiter must already be registered.
            const parked = cond.waitFor(() => value, 1000)
            value = true
            cond.notifyAll()
            await expect(parked).resolves.toBe(true)
        })
    })

    context("cleanup", () => {
        it("leaves no dangling timer after a satisfied wait (process can exit)", async () => {
            const cond = makeCondition()
            const f = flag(cond)
            const parked = cond.waitFor(f.ready, 60_000) // huge timeout
            await tick()
            f.flip()
            await expect(parked).resolves.toBe(true)
            // If the 60s timer were still armed, bun's test runner would hang at
            // teardown waiting it out. Reaching here promptly proves it was cleared.
        })

        it("drops the registration on timeout so a later notify is a no-op", async () => {
            const cond = makeCondition()
            await expect(cond.waitFor(() => false, 5)).resolves.toBe(false)
            // The waiter timed out and unregistered; a stray notify must not throw
            // or resurrect anything.
            expect(() => cond.notifyAll()).not.toThrow()
        })
    })
})
