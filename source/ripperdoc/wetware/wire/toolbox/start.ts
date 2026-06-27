#!/usr/bin/env bun
/**
 * start.ts — the detached ORCHESTRATOR. Port of the original `wire start`
 * command.
 *
 * Idempotent: if a room is already on disk AND /health answers, re-print its
 * handoff and exit 0 — never a second server. Otherwise spawn `serve` DETACHED
 * (its own log file, `unref()`'d so it outlives this process), then poll until
 * the child has written state under ITS pid and /health answers, and print the
 * operator handoff. We only bail early if the child actually exits; a transient
 * (state not written yet, a /health that refuses mid-boot) just means "not ready
 * yet" within the generous deadline.
 *
 * DETACHMENT CAVEAT: Bun.spawn has no `detached`/setsid option, so the child is
 * not put in its own session/process-group. We rely on `unref()` + redirecting
 * stdout/stderr to the log file (no controlling-terminal writes). On the happy
 * path the child outlives `start`; whether that survives a parent-session
 * teardown (e.g. terminal close) on macOS needs a live check.
 */

import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { defineCommand, effect, execute } from "cmdore"
import { integer } from "./coerce.ts"
import { healthOk, logPath, readState, renderHandoff, type WireState } from "./core/lifecycle.ts"
import { resolveStartTimeout, START_POLL_INTERVAL } from "./knobs.ts"

/** Absolute path to the sibling `serve.ts` the child runs. */
const SERVE_PATH = path.join(import.meta.dir, "serve.ts")

/** How many trailing log lines to surface when the child fails to come up. */
const LOG_TAIL_LINES = 30

/** Grace given a TERM'd child to exit before SIGKILL on the failure path, in ms. */
const CHILD_TERM_GRACE_MS = 2000

/** The launch knobs start forwards to the child; integer knobs are `undefined` when unset. */
export type StartOptions = {
    host: string
    port: number
    secret: string
    topic: string
    idleTimeout?: number
    sweepInterval?: number
    emptyGrace?: number
    maxConnections?: number
    publicUrl?: string
}

/** Sleep `ms` milliseconds (the poll cadence helper). */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Build the `serve` argv for the detached child.
 *
 * Value-bearing options use the `--opt=value` form, NOT two tokens, because a
 * value can legitimately begin with a dash (an operator-supplied `--secret` is
 * free-form). As two tokens the child would read a leading-dash value as a new
 * option and die before binding; `--opt=value` binds it unambiguously regardless
 * of its first character. The idle/sweep/empty/cap/public-url knobs are emitted
 * ONLY when explicitly set on the parent (`undefined` = unset) so an unset flag
 * is omitted and the child resolves its own env/default — preserving
 * flag>env>default end to end.
 *
 * @param options - the resolved launch knobs; see {@link StartOptions}.
 * @param servePath - absolute path to `serve.ts` (default: the sibling file).
 * @returns the full spawn argv: `[execPath, serve.ts, "serve", "--topic=…", …]`.
 */
export const serveArgv = (options: StartOptions, servePath: string = SERVE_PATH): string[] => {
    const argv = [
        process.execPath,
        servePath,
        "serve",
        `--topic=${options.topic}`,
        `--secret=${options.secret}`,
        `--host=${options.host}`,
        `--port=${options.port}`
    ]
    if (options.idleTimeout !== undefined) {
        argv.push(`--idle-timeout=${options.idleTimeout}`)
    }
    if (options.sweepInterval !== undefined) {
        argv.push(`--sweep-interval=${options.sweepInterval}`)
    }
    if (options.emptyGrace !== undefined) {
        argv.push(`--empty-grace=${options.emptyGrace}`)
    }
    if (options.maxConnections !== undefined) {
        argv.push(`--max-connections=${options.maxConnections}`)
    }
    if (options.publicUrl !== undefined) {
        argv.push(`--public-url=${options.publicUrl}`)
    }
    return argv
}

/** The outcome of {@link start}: the handoff text to print and the process exit code. */
export type StartResult = {
    handoff: string | null
    code: number
}

/**
 * Orchestrate the launch: reuse a live room, else spawn `serve` detached and
 * wait for it to come up.
 *
 * The spawn rides `effect()`, so `--dry-run` rehearses the idempotent reuse path
 * and the argv build without ever forking a server. On the spawn path it polls
 * up to {@link resolveStartTimeout} seconds for the child's pid-matched state +
 * /health, returns the handoff on success, and on failure tails the log and
 * terminates the child.
 *
 * @param options - the resolved launch knobs; see {@link StartOptions}.
 * @returns the handoff to print (or null) and the exit code (0 ok, 1 failed-to-come-up).
 *
 * @example
 * const { handoff, code } = await start({ host: "127.0.0.1", port: 5555, secret: "s", topic: "sync" })
 */
export const start = async (options: StartOptions): Promise<StartResult> => {
    // Idempotent: a live room already on disk → re-print its handoff, don't respawn.
    const existing = await readState()
    if (existing !== null && (await healthOk(existing.host, existing.port))) {
        return { handoff: renderHandoff(existing.url, existing.secret), code: 0 }
    }

    // Stale state (file present, nothing answering) is harmless — serve overwrites it.
    const log = await logPath()
    const child = (await effect(() => {
        const fd = fs.openSync(log, "w")
        try {
            const proc = Bun.spawn(serveArgv(options), {
                stdin: "ignore",
                stdout: fd,
                stderr: fd
            })
            // The child must outlive `start`, which exits after the handoff.
            proc.unref()
            return proc
        } finally {
            fs.closeSync(fd)
        }
    })) as ReturnType<typeof Bun.spawn> | undefined

    // Dry-run: no child was spawned — rehearsal ends here.
    if (child === undefined) {
        return { handoff: null, code: 0 }
    }

    // Poll until the serve process has written state under ITS pid AND /health
    // answers. Stop early only if the child actually exits; a transient (state
    // not written, a /health refusal mid-boot) just means "not ready yet".
    const deadline = Date.now() + resolveStartTimeout() * 1000
    let childExited = false
    while (Date.now() < deadline) {
        const state: WireState | null = await readState()
        if (state !== null && state.pid === child.pid && (await healthOk(state.host, state.port))) {
            return { handoff: renderHandoff(state.url, state.secret), code: 0 }
        }
        if (child.exitCode !== null || child.signalCode !== null) {
            childExited = true
            break
        }
        await sleep(START_POLL_INTERVAL * 1000)
    }

    // Timed out or the child exited. Report the log tail, ensure the child is dead.
    process.stderr.write("wire: error: server failed to come up\n")
    try {
        const text = await fsp.readFile(log, "utf-8")
        const tail = text
            .split("\n")
            .filter((line) => line.length > 0)
            .slice(-LOG_TAIL_LINES)
        if (tail.length > 0) {
            process.stderr.write("--- wire.log tail ---\n")
            process.stderr.write(`${tail.join("\n")}\n`)
        }
    } catch {
        // log unreadable — best-effort tail.
    }
    if (!childExited && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM")
        const killBy = Date.now() + CHILD_TERM_GRACE_MS
        while (Date.now() < killBy && child.exitCode === null && child.signalCode === null) {
            await sleep(50)
        }
        if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL")
        }
    }
    return { handoff: null, code: 1 }
}

const command = defineCommand({
    name: "start",
    description: "Spawn the wire server detached and print the operator handoff.",
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
            name: "idle-timeout",
            arity: 1,
            hint: "n",
            description: "seconds of silence before a peer is dropped; 0 disables (env WIRE_IDLE_TIMEOUT, default 300)",
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
        const secret = argv.secret ?? (await import("node:crypto")).randomBytes(4).toString("hex")
        const { handoff, code } = await start({
            host: argv.host,
            port: argv.port,
            secret,
            topic: argv.topic,
            idleTimeout: argv["idle-timeout"],
            sweepInterval: argv["sweep-interval"],
            emptyGrace: argv["empty-grace"],
            maxConnections: argv["max-connections"],
            publicUrl: argv["public-url"]
        })
        if (handoff !== null) {
            process.stdout.write(`${handoff}\n`)
        }
        if (code !== 0) {
            process.exit(code)
        }
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
