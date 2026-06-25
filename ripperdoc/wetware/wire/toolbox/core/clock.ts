/**
 * clock.ts — the monotonic time source the wire core reads.
 *
 * Mirrors Python's ``time.monotonic`` seam: every duration in the core (recv
 * parks, idle drop, empty-room grace) is measured in SECONDS against a single
 * injectable clock, so tests can fast-forward without real waiting. The default
 * `monotonic` reads `performance.now()` (milliseconds) and divides by 1000 to
 * match the Python contract exactly — a float count of seconds that only ever
 * moves forward.
 */

/** A monotonic time source: returns a float count of SECONDS, never decreasing. */
export type Clock = () => number

/** Default clock — `performance.now()` (ms) in SECONDS, mirroring `time.monotonic`. */
export const monotonic: Clock = () => performance.now() / 1000

/**
 * A controllable clock that returns its mutable `.now`, mirroring the Python
 * `_FakeClock` in test_room.py. Reads return the current value; tests assign
 * `clock.now` (or add to it) to fast-forward with zero real waiting.
 *
 * The returned value is callable (a `Clock`) AND carries a writable `now`, so it
 * drops straight into anything expecting a `Clock`.
 */
export type FakeClock = Clock & { now: number }

/** Build a `FakeClock` seeded at `start` (default 1000, matching the Python seam). */
export const fakeClock = (start = 1000): FakeClock => {
    const clock = (() => clock.now) as FakeClock
    clock.now = start
    return clock
}
