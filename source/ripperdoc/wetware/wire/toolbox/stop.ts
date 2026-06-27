#!/usr/bin/env bun
/**
 * stop.ts — TERM/KILL the tracked room, confirm it's down, clear state. Port of
 * the original `wire stop` command.
 *
 * Reads the state file: nothing → "nothing running". A dead pid (the process is
 * gone) → clear the stale state and report it, no signal. A live pid → SIGTERM,
 * poll up to {@link STOP_TIMEOUT}s, escalate to SIGKILL if it clings, clear
 * state, and warn (exit 1) if /health is somehow STILL answering after the stop.
 *
 * The signal sends and the state clear ride `effect()`, so `--dry-run` rehearses
 * the decision (which branch, which signal) without actually killing a process or
 * deleting the file.
 */

import { defineCommand, effect, execute } from "cmdore"
import { clearState, healthOk, readState } from "./core/lifecycle.ts"
import { STOP_POLL_INTERVAL, STOP_TIMEOUT } from "./knobs.ts"

/** The outcome of {@link stop}: the line to print, where it goes, and the exit code. */
export type StopResult = {
    message: string
    stream: "stdout" | "stderr"
    code: number
}

/** Sleep `ms` milliseconds (the poll cadence helper). */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * True if a signal can be delivered to `pid` (the process exists). `kill(pid, 0)`
 * delivers no signal — it only probes: ESRCH (no such process) → false, EPERM
 * (exists but not ours) → true. Mirrors the original `_pid_alive`.
 */
export const pidAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EPERM") {
            return true
        }
        return false
    }
}

/**
 * Stop the tracked room and clear its state.
 *
 * No state → a no-op success. A dead pid → clear the stale file, success. A live
 * pid → SIGTERM, poll, SIGKILL if needed, clear, then a /health re-probe: a
 * server still answering after all that is a failure (exit 1). The kills and the
 * clear ride `effect()` so `--dry-run` decides the branch without side-effects.
 *
 * @returns the message, its stream, and the exit code (0 ok, 1 if /health survives the stop).
 *
 * @example
 * const { message, code } = await stop() // "wire: stopped (pid 1234, port 5555, via SIGTERM); state cleared."
 */
export const stop = async (): Promise<StopResult> => {
    const state = await readState()
    if (state === null) {
        return { message: "wire: nothing running", stream: "stdout", code: 0 }
    }

    const { pid, port, host } = state

    if (!pidAlive(pid)) {
        await effect(() => clearState())
        return {
            message: `wire: stale state cleared (pid ${pid} not running, port ${port}).`,
            stream: "stdout",
            code: 0
        }
    }

    await effect(() => process.kill(pid, "SIGTERM"))
    const deadline = Date.now() + STOP_TIMEOUT * 1000
    while (Date.now() < deadline && pidAlive(pid)) {
        await sleep(STOP_POLL_INTERVAL * 1000)
    }

    let killedHard = false
    if (pidAlive(pid)) {
        await effect(() => process.kill(pid, "SIGKILL"))
        killedHard = true
        await sleep(500)
    }

    await effect(() => clearState())

    if (await healthOk(host, port)) {
        return {
            message: `wire: WARN — /health on port ${port} still answering after stop.`,
            stream: "stderr",
            code: 1
        }
    }

    const how = killedHard ? "SIGKILL" : "SIGTERM"
    return {
        message: `wire: stopped (pid ${pid}, port ${port}, via ${how}); state cleared.`,
        stream: "stdout",
        code: 0
    }
}

const command = defineCommand({
    name: "stop",
    description: "Stop the tracked wire server and clear its state.",
    arguments: [],
    options: [],
    run: async () => {
        const { message, stream, code } = await stop()
        if (stream === "stderr") {
            process.stderr.write(`${message}\n`)
        } else {
            process.stdout.write(`${message}\n`)
        }
        if (code !== 0) {
            process.exit(code)
        }
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
