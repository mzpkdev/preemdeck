#!/usr/bin/env bun
/**
 * serve.ts — the FOREGROUND wire server (blocking). Port of `wire serve` in
 * server/src/wire/cli.py.
 *
 * Resolves a free port, builds the frozen Config (which asserts
 * idleTimeout > waitMax), writes the state file — it is the SINGLE writer —
 * prints the greppable `wire: ready` banner, then runs Bun.serve (blocking)
 * until a signal. The real side-effects (the state write, the bind, the block)
 * ride `effect()`, so `--dry-run` rehearses — resolve port, validate, would-print
 * the banner — WITHOUT binding or blocking.
 *
 * Concurrency cap (the 503): app.fetch is wrapped in an in-flight counter that
 * answers 503 once over `config.maxConnections` (skipped when 0 = unlimited),
 * bounding the unauthenticated-flood blast radius, mirroring uvicorn's
 * limit_concurrency.
 */

import * as crypto from "node:crypto"
import { defineCommand, effect, execute } from "cmdore"
import { integer } from "./coerce.ts"
import { createApp } from "./core/app.ts"
import { makeConfig } from "./core/config.ts"
import { detectLanIp, findFreePort, writeState } from "./core/lifecycle.ts"
import {
    resolveEmptyGrace,
    resolveIdleTimeout,
    resolveMaxConnections,
    resolvePublicUrl,
    resolveSweepInterval
} from "./knobs.ts"

/** Bun's idle-timeout is a byte, capped at 255s; trim slow-loris holds like uvicorn's keep-alive. */
const SERVE_IDLE_SECONDS = 10

/** Raised to fail the launch cleanly (exit 1) with a `wire: error:` message, like the Python's early returns. */
export class ServeError extends Error {}

/** The launch knobs serve resolves; the integer knobs are `undefined` when unset (flag>env>default applies). */
export type ServeOptions = {
    host: string
    port: number
    secret?: string
    topic: string
    waitDefault: number
    waitMax: number
    idleTimeout?: number
    sweepInterval?: number
    emptyGrace?: number
    maxConnections?: number
    publicUrl?: string
}

/**
 * Wrap `fetch` in an in-flight counter that returns 503 once `max` requests are
 * already running (0 = unlimited → the handler is returned as-is). This bounds
 * the unauthenticated-flood blast radius the way uvicorn's `limit_concurrency`
 * does — excess connections are shed, not queued.
 */
export const capConcurrency = (
    handler: (request: Request) => Response | Promise<Response>,
    max: number
): ((request: Request) => Response | Promise<Response>) => {
    if (max <= 0) {
        return handler
    }
    let inFlight = 0
    return async (request: Request): Promise<Response> => {
        if (inFlight >= max) {
            return new Response("Service Unavailable", { status: 503 })
        }
        inFlight++
        try {
            return await handler(request)
        } finally {
            inFlight--
        }
    }
}

/**
 * Run the foreground server: resolve a free port, build + validate the Config,
 * write the state file, print the banner, then bind and block until a signal.
 *
 * The state write, the `Bun.serve` bind, and the shutdown block are wrapped in
 * `effect()` so `--dry-run` rehearses the deterministic prelude (port scan,
 * scheme + idle/wait validation, banner) without touching a port or blocking.
 *
 * @param options - the resolved launch knobs; see {@link ServeOptions}.
 * @returns a promise that resolves when the server has stopped (immediately on dry-run).
 * @throws {ServeError} on a malformed public URL or a bad idle/wait config — the CLI maps it to exit 1.
 *
 * @example
 * await serve({ host: "127.0.0.1", port: 5555, topic: "sync", waitDefault: 30, waitMax: 60 })
 */
export const serve = async (options: ServeOptions): Promise<void> => {
    const secret = options.secret ?? crypto.randomBytes(4).toString("hex")

    let port: number
    try {
        port = await findFreePort(options.host, options.port)
    } catch (error) {
        throw new ServeError(error instanceof Error ? error.message : String(error))
    }

    const idleTimeout = resolveIdleTimeout(options.idleTimeout)
    const sweepInterval = resolveSweepInterval(options.sweepInterval)
    const emptyGrace = resolveEmptyGrace(options.emptyGrace)
    const maxConnections = resolveMaxConnections(options.maxConnections)
    const publicUrl = resolvePublicUrl(options.publicUrl)

    // A declared public URL must be a real http(s) base; a malformed value would
    // hand peers an unusable URL, so fail the launch cleanly rather than booting
    // with a broken base.
    if (publicUrl !== null && !publicUrl.startsWith("http://") && !publicUrl.startsWith("https://")) {
        throw new ServeError(
            `--public-url (${publicUrl}) must start with http:// or https:// (env WIRE_PUBLIC_URL); ` +
                "it's the public base peers read, so it has to be a full URL."
        )
    }

    // makeConfig asserts idleTimeout > waitMax (a parked /recv holds a peer silent
    // up to waitMax); a bad config throws here, surfaced cleanly as exit 1.
    let config: ReturnType<typeof makeConfig>
    try {
        config = makeConfig({
            host: options.host,
            port,
            secret,
            topic: options.topic,
            waitDefault: options.waitDefault,
            waitMax: options.waitMax,
            publicUrl,
            idleTimeout,
            sweepInterval,
            emptyGrace,
            maxConnections
        })
    } catch (error) {
        throw new ServeError(error instanceof Error ? error.message : String(error))
    }

    const { app, room, startReaper } = createApp(config)

    // The declared public URL (e.g. a tunnel) wins for both the state file and the
    // handoff; with none set, fall back to the LAN base as before.
    const urlhost = config.host === "" || config.host === "0.0.0.0" ? await detectLanIp() : config.host
    const url = publicUrl ?? `http://${urlhost}:${port}`

    // The serve process is the single writer of the state file. Skipped on dry-run.
    await effect(() =>
        writeState({
            pid: process.pid,
            host: config.host,
            port: config.port,
            secret: config.secret,
            url,
            topic: config.topic
        })
    )

    // Stable, greppable startup banner. KEEP THIS SHAPE STABLE. Printed even on
    // dry-run (it's the rehearsal output the spec asserts).
    process.stdout.write(
        `wire: ready host=${config.host} port=${config.port} pid=${process.pid} secret=${config.secret}\n`
    )
    // `room` is consumed by the reaper below; reference it so the bind block reads cleanly.
    void room

    const wrappedFetch = capConcurrency((request) => app.fetch(request), config.maxConnections)

    // The bind + block ride effect(): on dry-run it is skipped and resolves
    // undefined, so serve returns without ever touching a port or parking.
    await effect(
        () =>
            new Promise<void>((resolve) => {
                const server = Bun.serve({
                    fetch: wrappedFetch,
                    hostname: config.host,
                    port: config.port,
                    idleTimeout: Math.min(255, SERVE_IDLE_SECONDS)
                })
                let stopped = false
                const stopReaper = startReaper(() => {
                    // Empty-room self-close: drop the server, unblock, exit.
                    void server.stop(true)
                })
                const shutdown = (): void => {
                    if (stopped) {
                        return
                    }
                    stopped = true
                    stopReaper()
                    // serve does NOT clear state — `stop` owns that (mirrors cli.py).
                    void server.stop(true)
                    resolve()
                }
                process.once("SIGINT", shutdown)
                process.once("SIGTERM", shutdown)
            })
    )
}

const command = defineCommand({
    name: "serve",
    description: "Run the wire server in the foreground (blocking).",
    arguments: [],
    options: [
        {
            name: "topic",
            arity: 1,
            hint: "topic",
            required: true,
            description: "conversation topic, handed to peers on /jackin"
        },
        {
            name: "secret",
            arity: 1,
            hint: "key",
            description: "key gating /shard and /jackin; auto-generated (8 hex) if omitted"
        },
        {
            name: "host",
            arity: 1,
            hint: "addr",
            description: "address the HTTP layer binds to",
            defaultValue: () => "0.0.0.0"
        },
        {
            name: "port",
            arity: 1,
            hint: "n",
            description: "starting port for the free-port scan",
            coerce: integer,
            defaultValue: () => 5555
        },
        {
            name: "wait-default",
            arity: 1,
            hint: "n",
            description: "seconds a quiet /recv parks",
            coerce: integer,
            defaultValue: () => 30
        },
        {
            name: "wait-max",
            arity: 1,
            hint: "n",
            description: "server-side clamp on a caller wait",
            coerce: integer,
            defaultValue: () => 60
        },
        {
            name: "idle-timeout",
            arity: 1,
            hint: "n",
            description:
                "seconds of silence before a peer is dropped; 0 disables (env WIRE_IDLE_TIMEOUT, default 300). Must exceed --wait-max when > 0",
            coerce: integer
        },
        {
            name: "sweep-interval",
            arity: 1,
            hint: "n",
            description: "seconds between idle sweeps (env WIRE_SWEEP_INTERVAL, default 15)",
            coerce: integer
        },
        {
            name: "empty-grace",
            arity: 1,
            hint: "n",
            description:
                "seconds an empty roster is tolerated before self-close; 0 disables (env WIRE_EMPTY_GRACE, default 900)",
            coerce: integer
        },
        {
            name: "max-connections",
            arity: 1,
            hint: "n",
            description: "max concurrent connections before 503; 0 = unlimited (env WIRE_MAX_CONNECTIONS, default 64)",
            coerce: integer
        },
        {
            name: "public-url",
            arity: 1,
            hint: "url",
            description: "public base URL peers read (e.g. https://x.ngrok.io); must be http(s) (env WIRE_PUBLIC_URL)"
        }
    ],
    run: async (argv) => {
        try {
            await serve({
                host: argv.host,
                port: argv.port,
                secret: argv.secret,
                topic: argv.topic,
                waitDefault: argv["wait-default"],
                waitMax: argv["wait-max"],
                idleTimeout: argv["idle-timeout"],
                sweepInterval: argv["sweep-interval"],
                emptyGrace: argv["empty-grace"],
                maxConnections: argv["max-connections"],
                publicUrl: argv["public-url"]
            })
        } catch (error) {
            if (error instanceof ServeError) {
                process.stderr.write(`wire: error: ${error.message}\n`)
                process.exit(1)
            }
            throw error
        }
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
