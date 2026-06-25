/**
 * condition.ts — the single-waiter-friendly condition primitive the wire core
 * parks long-polls on. The room guards every long-poll with one of these.
 *
 * A /recv parks until `predicate()` is true OR the timeout fires; every write
 * calls `notifyAll()` to wake parked waiters to re-test. Bun is single-threaded
 * with no built-in condition primitive, so we model it with promises.
 *
 * Correctness contract:
 *  - NO LOST NOTIFIES — a waiter registers its resolver in a pending set BEFORE
 *    it parks, so a `notifyAll()` racing the registration still wakes it. (We
 *    fast-path an already-true predicate without ever registering.)
 *  - SPURIOUS-WAKE SAFE — woken waiters re-test the predicate in a loop and
 *    either return `true` or re-park, so an unrelated notify never resolves a
 *    waiter whose condition isn't yet met.
 *  - NO LEAKS — on resolve (predicate true OR timeout) the waiter clears its
 *    timer and drops its registration; nothing dangles.
 */

/** A resolver parked in the pending set; calling it wakes that one waiter to re-test. */
type Waiter = () => void

/**
 * A condition variable: many waiters park on `waitFor`; `notifyAll` wakes them
 * all to re-test their predicates. Single-threaded — no lock is needed or held.
 */
export type Condition = {
    /**
     * Resolve `true` as soon as `predicate()` is true; resolve `false` if
     * `timeoutMs` elapses first. The predicate is checked immediately (an
     * already-true predicate resolves `true` with no parking and no notify
     * needed) and re-checked on every `notifyAll`, looping to absorb spurious
     * wakes. Timer + registration are cleaned up on either outcome.
     */
    waitFor: (predicate: () => boolean, timeoutMs: number) => Promise<boolean>
    /** Wake EVERY currently-parked waiter to re-test its predicate. */
    notifyAll: () => void
}

/** Build a fresh, independent `Condition`. */
export const makeCondition = (): Condition => {
    // The live set of parked resolvers. notifyAll drains a snapshot of this so a
    // waiter that re-parks during the drain isn't woken twice by one notify.
    const waiters = new Set<Waiter>()

    const notifyAll = (): void => {
        const woken = [...waiters]
        waiters.clear()
        for (const wake of woken) {
            wake()
        }
    }

    const waitFor = (predicate: () => boolean, timeoutMs: number): Promise<boolean> =>
        new Promise<boolean>((resolve) => {
            // Fast path: already satisfied — resolve without parking or arming a
            // timer (no notify is required to wake us).
            if (predicate()) {
                resolve(true)
                return
            }

            let timer: ReturnType<typeof setTimeout> | undefined
            let waiter: Waiter

            // Drop our registration and timer exactly once, on whichever outcome
            // fires first, so nothing dangles.
            const cleanup = (): void => {
                waiters.delete(waiter)
                if (timer !== undefined) {
                    clearTimeout(timer)
                    timer = undefined
                }
            }

            // Woken by a notify: re-test. If satisfied, resolve true and clean
            // up; otherwise re-park by re-registering for the next notify.
            waiter = () => {
                if (predicate()) {
                    cleanup()
                    resolve(true)
                } else {
                    waiters.add(waiter)
                }
            }

            timer = setTimeout(() => {
                timer = undefined
                cleanup()
                resolve(false)
            }, timeoutMs)

            // Register BEFORE returning to the event loop so a notify that races
            // this call still finds us parked — no lost wakeups.
            waiters.add(waiter)
        })

    return { waitFor, notifyAll }
}
