#!/usr/bin/env bun
/**
 * status.ts — report whether the tracked room is up. Port of `wire status` in
 * server/src/wire/cli.py.
 *
 * Reads the state file: nothing → "not running". Otherwise probe /health and
 * print up/down with the room's host, port, url, and secret. Read-only — it
 * neither writes nor clears state — so there is nothing to gate behind
 * `effect()`; `--dry-run` and a live run behave identically.
 */

import { defineCommand, execute } from "cmdore"
import { healthOk, readState } from "./core/lifecycle.ts"

/** The outcome of {@link status}: the text to print and the exit code (always 0). */
export type StatusResult = {
    message: string
    code: number
}

/**
 * Report the tracked room's address + secret and whether it's up.
 *
 * @returns the status block (or "not running") and exit code 0.
 *
 * @example
 * const { message } = await status() // "wire: up\n  host:   …\n  port:   …\n  url:    …\n  secret: …"
 */
export const status = async (): Promise<StatusResult> => {
    const state = await readState()
    if (state === null) {
        return { message: "wire: not running", code: 0 }
    }

    const up = await healthOk(state.host, state.port)
    const label = up ? "up" : "down"
    const message =
        `wire: ${label}\n` +
        `  host:   ${state.host}\n` +
        `  port:   ${state.port}\n` +
        `  url:    ${state.url}\n` +
        `  secret: ${state.secret}`
    return { message, code: 0 }
}

const command = defineCommand({
    name: "status",
    description: "Report whether the tracked wire server is up.",
    arguments: [],
    options: [],
    run: async () => {
        const { message } = await status()
        process.stdout.write(`${message}\n`)
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
