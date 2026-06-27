/**
 * config.ts — launch configuration for a wire room. Port of the original wire's
 * config layer.
 *
 * The single anchor every other core module reads. Frozen (the original's frozen
 * dataclass analog via `Object.freeze`) and dependency-free, so
 * the core stays unit-testable without binding a port.
 *
 * Field docs (host/port are never read by the core; durations are SECONDS):
 *  - host / port      — where the HTTP layer binds.
 *  - secret           — the key gating /shard and /jackin.
 *  - topic            — conversation topic, handed to peers on /jackin.
 *  - publicUrl        — operator-declared public base URL (behind a tunnel);
 *                       null falls back to the request/LAN base.
 *  - waitDefault      — seconds a quiet /recv parks before a heartbeat.
 *  - waitMax          — server-side clamp on a caller-supplied wait.
 *  - idleTimeout      — seconds of silence before a peer is dropped; 0 disables.
 *                       MUST stay larger than `waitMax` (asserted below).
 *  - sweepInterval    — seconds between idle sweeps (the reaper interval).
 *  - emptyGrace       — seconds an empty roster is tolerated before self-close;
 *                       0 disables. Boot-armed.
 *  - maxConnections   — server-level concurrent-connection ceiling; 0 disables.
 */

/** Immutable launch args for one room. Build via `makeConfig`; never mutate. */
export type Config = {
    readonly host: string
    readonly port: number
    readonly secret: string
    readonly topic: string
    readonly publicUrl: string | null
    readonly waitDefault: number
    readonly waitMax: number
    readonly idleTimeout: number
    readonly sweepInterval: number
    readonly emptyGrace: number
    readonly maxConnections: number
}

/** The fields a caller must supply; every other field has a default. */
export type ConfigInput = Pick<Config, "host" | "port" | "secret" | "topic"> & Partial<Config>

/** Defaults for every optional field, mirroring the original's dataclass defaults. */
export const CONFIG_DEFAULTS = {
    publicUrl: null,
    waitDefault: 30,
    waitMax: 60,
    idleTimeout: 300,
    sweepInterval: 15,
    emptyGrace: 900,
    maxConnections: 64
} as const

/**
 * Build a frozen `Config` from `input`, applying `CONFIG_DEFAULTS` for any
 * omitted optional field.
 *
 * Asserts the load-bearing invariant `idleTimeout > waitMax` (only when idle
 * drop is on, i.e. `idleTimeout > 0`): a parked /recv holds a peer silent up to
 * `waitMax`, and `lastActive` is stamped at recv ENTRY, so a peer re-polling
 * within `idleTimeout` always stays alive. If `idleTimeout <= waitMax` a quiet
 * long-poller could be reaped mid-park — so this throws rather than build it.
 */
export const makeConfig = (input: ConfigInput): Config => {
    const config: Config = {
        host: input.host,
        port: input.port,
        secret: input.secret,
        topic: input.topic,
        publicUrl: input.publicUrl ?? CONFIG_DEFAULTS.publicUrl,
        waitDefault: input.waitDefault ?? CONFIG_DEFAULTS.waitDefault,
        waitMax: input.waitMax ?? CONFIG_DEFAULTS.waitMax,
        idleTimeout: input.idleTimeout ?? CONFIG_DEFAULTS.idleTimeout,
        sweepInterval: input.sweepInterval ?? CONFIG_DEFAULTS.sweepInterval,
        emptyGrace: input.emptyGrace ?? CONFIG_DEFAULTS.emptyGrace,
        maxConnections: input.maxConnections ?? CONFIG_DEFAULTS.maxConnections
    }
    if (config.idleTimeout > 0 && config.idleTimeout <= config.waitMax) {
        throw new Error(
            `idleTimeout (${config.idleTimeout}) must exceed waitMax (${config.waitMax}); ` +
                "a parked /recv holds a peer silent up to waitMax and would otherwise be reaped"
        )
    }
    return Object.freeze(config)
}
