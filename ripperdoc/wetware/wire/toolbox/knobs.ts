/**
 * knobs.ts — the flag > env > default resolvers shared by serve and start.
 * Port of the original `_idle_timeout` / `_sweep_interval` / `_empty_grace` /
 * `_max_connections` / `_public_url` / `_start_timeout` helpers.
 *
 * Each resolver takes the already-parsed flag value (`undefined` when the flag
 * was not passed — cmdore leaves an absent arity-1 option `undefined`) and
 * applies the same precedence as the original: an explicit flag wins; else the
 * env var (if valid); else the Config default. The "valid" bar matches the
 * original per-knob — most accept any non-negative int (0 is MEANINGFUL: it
 * disables idle drop / empty self-close / the connection cap), while the sweep
 * interval requires a positive cadence and the start timeout a positive float.
 *
 * Kept dependency-free and primitive-parameterized (no Config import) so it
 * stays unit-testable and the command files import a single resolver each.
 */

import { CONFIG_DEFAULTS } from "./core/config.ts"

/** Generous default `start` waits for the detached child to come up, in seconds. */
export const START_TIMEOUT_DEFAULT = 30

/** Poll cadence while `start` waits for the child, in seconds. */
export const START_POLL_INTERVAL = 0.2

/** Bound on how long `stop` waits for a TERM'd process to exit, in seconds. */
export const STOP_TIMEOUT = 5

/** Poll cadence while `stop` waits for the process to exit, in seconds. */
export const STOP_POLL_INTERVAL = 0.2

/**
 * Parse a base-10 integer exactly (the strict `int()` bar): optional sign, all
 * digits, no trailing junk. Returns `null` on anything unparseable so a garbage
 * env value falls through to the default rather than poisoning a knob.
 */
const parseIntStrict = (raw: string): number | null => {
    if (!/^[+-]?\d+$/.test(raw.trim())) {
        return null
    }
    return Number.parseInt(raw, 10)
}

/**
 * Resolve a non-negative-int knob: flag > env > default. 0 is accepted (it is a
 * meaningful "disable" for idle/empty/cap); only a negative or unparseable env
 * value falls through. Mirrors `_idle_timeout` / `_empty_grace` /
 * `_max_connections`.
 */
const resolveNonNegative = (flag: number | undefined, envName: string, fallback: number): number => {
    if (flag !== undefined) {
        return flag
    }
    const raw = process.env[envName]
    if (raw !== undefined) {
        const val = parseIntStrict(raw)
        if (val !== null && val >= 0) {
            return val
        }
    }
    return fallback
}

/** Resolve the idle-drop timeout: flag > `WIRE_IDLE_TIMEOUT` env > default (0 disables). */
export const resolveIdleTimeout = (flag: number | undefined): number =>
    resolveNonNegative(flag, "WIRE_IDLE_TIMEOUT", CONFIG_DEFAULTS.idleTimeout)

/** Resolve the empty-room grace: flag > `WIRE_EMPTY_GRACE` env > default (0 disables). */
export const resolveEmptyGrace = (flag: number | undefined): number =>
    resolveNonNegative(flag, "WIRE_EMPTY_GRACE", CONFIG_DEFAULTS.emptyGrace)

/** Resolve the connection cap: flag > `WIRE_MAX_CONNECTIONS` env > default (0 = unlimited). */
export const resolveMaxConnections = (flag: number | undefined): number =>
    resolveNonNegative(flag, "WIRE_MAX_CONNECTIONS", CONFIG_DEFAULTS.maxConnections)

/**
 * Resolve the sweep interval: flag > `WIRE_SWEEP_INTERVAL` env > default. The
 * interval is a positive cadence, so the env requires `> 0`; anything else falls
 * back. Mirrors `_sweep_interval`.
 */
export const resolveSweepInterval = (flag: number | undefined): number => {
    if (flag !== undefined) {
        return flag
    }
    const raw = process.env.WIRE_SWEEP_INTERVAL
    if (raw !== undefined) {
        const val = parseIntStrict(raw)
        if (val !== null && val > 0) {
            return val
        }
    }
    return CONFIG_DEFAULTS.sweepInterval
}

/**
 * Resolve the public base URL: flag > `WIRE_PUBLIC_URL` env > null. The chosen
 * value is normalized — a trailing `/` is stripped so callers can pass
 * `https://x.ngrok.io/` or `https://x.ngrok.io` interchangeably. Does NOT
 * validate the scheme (that check lives in serve, which can fail the launch
 * cleanly); this stays a pure precedence helper. Mirrors `_public_url`.
 */
export const resolvePublicUrl = (flag: string | undefined): string | null => {
    const value = flag !== undefined ? flag : process.env.WIRE_PUBLIC_URL
    if (value === undefined) {
        return null
    }
    return value.replace(/\/+$/, "")
}

/**
 * Seconds `start` waits for the detached server to come up: `WIRE_START_TIMEOUT`
 * env > default. A fresh child must import the runtime, bind a port, write state,
 * and answer /health — generous, not tight, so a slow-to-wake but healthy child
 * is not mistaken for a dead one. Anything unparseable or non-positive falls
 * back to the default. Mirrors `_start_timeout`.
 */
export const resolveStartTimeout = (): number => {
    const raw = process.env.WIRE_START_TIMEOUT
    if (raw !== undefined) {
        const val = Number(raw)
        if (Number.isFinite(val) && val > 0) {
            return val
        }
    }
    return START_TIMEOUT_DEFAULT
}
