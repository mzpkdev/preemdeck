#!/usr/bin/env -S preemdeck-runtime
/**
 * os-notify.ts — raise an OS-wide desktop notification.
 *
 * macOS + Linux only. macOS prefers `terminal-notifier` (its own bundle = delivery
 * independent of the launching app's permissions), else osascript `display
 * notification`. Linux uses `notify-send`.
 *
 * SECURITY (preserved verbatim): user text is NEVER spliced into a script. The
 * osascript path reads title/body from environment variables (`system attribute`);
 * notify-send and terminal-notifier take them as argv. So quotes/backslashes/
 * newlines in the title/body can't break out into code — there's no script string
 * to break out of. The env vars are passed out-of-band via lib/proc.ts (merged
 * over process.env), never interpolated into the command line. cmdore only parses
 * the argv here; it never touches the spawn/env path below.
 *
 * Best-effort: returns the mechanism that fired, or null; the CLI surfaces null as
 * exit 1 (echoing the text to stderr) — there is NO universal floor for a banner.
 */

import type { StandardSchemaV1 } from "cmdore"
import { defineCommand, effect, execute } from "cmdore"
import { spawn } from "../../../../common/proc.ts"

const DEFAULT_TITLE = "PreemDeck"

// User text rides these env vars on macOS (out-of-band), never the script source.
const ENV_TITLE = "PD_NOTIFY_TITLE"
const ENV_MESSAGE = "PD_NOTIFY_MESSAGE"

/**
 * A static AppleScript that reads the title/body from the environment at run
 * time. Only our own constant env-var NAMES are interpolated here — never any
 * user text — which is what keeps the osascript path injection-proof: there is
 * no place in the script for hostile title/body to land.
 */
export const MACOS_APPLESCRIPT = `display notification (system attribute "${ENV_MESSAGE}") with title (system attribute "${ENV_TITLE}")`

/**
 * Run `cmd` to completion; resolve true iff it spawned and exited 0. `env` (if
 * given) is merged OVER the current environment (so PATH/DISPLAY survive and the
 * notification vars are added). A missing binary, non-zero exit, or timeout all
 * resolve false. Never throws.
 *
 * The spawn rides `effect()`, so under `--dry-run` it is skipped and resolves to
 * `undefined` — treated here as "the command fired" (true). That means the FIRST
 * mechanism in the chain "succeeds" under dry-run, so notify() returns it and the
 * CLI exits 0 (never the no-mechanism exit-1 path).
 */
export const runCmd = async (cmd: string[], env?: Record<string, string>): Promise<boolean> => {
    try {
        const result = (await effect(() => spawn(cmd, { timeoutMs: 20_000, env }))) as
            | Awaited<ReturnType<typeof spawn>>
            | undefined
        if (result === undefined) return true
        return !result.timedOut && result.exitCode === 0
    } catch {
        return false
    }
}

/** Whether an executable is on PATH — the Bun analogue of shutil.which. */
const which = (name: string): boolean => {
    return Bun.which(name) !== null
}

/** macOS: terminal-notifier if installed (and it fires), else osascript. */
export const notifyMacos = async (
    message: string,
    title: string,
    deps: {
        run?: (cmd: string[], env?: Record<string, string>) => Promise<boolean>
        has?: (name: string) => boolean
    } = {}
): Promise<string | null> => {
    const run = deps.run ?? runCmd
    const has = deps.has ?? which
    if (has("terminal-notifier") && (await run(["terminal-notifier", "-title", title, "-message", message]))) {
        return "terminal-notifier"
    }
    const env = { [ENV_TITLE]: title, [ENV_MESSAGE]: message }
    if (await run(["osascript", "-e", MACOS_APPLESCRIPT], env)) {
        return "osascript"
    }
    return null
}

/** Linux: notify-send (libnotify). Title/body are argv. "notify-send" or null. */
export const notifyLinux = async (
    message: string,
    title: string,
    run: (cmd: string[], env?: Record<string, string>) => Promise<boolean> = runCmd
): Promise<string | null> => {
    if (await run(["notify-send", title, message])) return "notify-send"
    return null
}

/** The per-OS notifier for the current platform (null worker on exotic OSes). */
export const platformWorker = (
    platform: string = process.platform
): ((message: string, title: string) => Promise<string | null>) => {
    if (platform === "darwin") return (message, title) => notifyMacos(message, title)
    if (platform === "linux") return (message, title) => notifyLinux(message, title)
    return async () => null // exotic platform: no desktop notifier to fall back to
}

/**
 * Raise an OS-wide desktop notification and report which mechanism fired.
 *
 * macOS tries `terminal-notifier` (argv) then osascript (the static
 * {@link MACOS_APPLESCRIPT}, fed title/body via env); Linux uses `notify-send`
 * (argv). Best-effort: every path is silent and never throws, so a missing
 * notifier degrades to a null return rather than an error.
 *
 * @param message - the notification body text.
 * @param title - the notification title (defaults to "PreemDeck").
 * @returns the mechanism that fired (e.g. "osascript"), or null when none is available.
 *
 * @example
 * await notify("Build finished") // "osascript" on a Mac, or null if nothing is installed
 * await notify("Tests failed", "CI") // titled "CI"
 */
export const notify = async (
    message: string,
    title: string = DEFAULT_TITLE,
    worker: (message: string, title: string) => Promise<string | null> = platformWorker()
): Promise<string | null> => {
    return worker(message, title)
}

/**
 * A Standard Schema for the required `message` positional. cmdore hands the
 * variadic operands in as a `string[]`; this enforces exactly one (zero is caught
 * earlier by `required`), surfacing a CmdoreError (exit 2) on a second positional,
 * and unwraps the single value back to a plain string for `run`.
 */
const messageSchema: StandardSchemaV1<string> = {
    "~standard": {
        version: 1,
        vendor: "preemdeck",
        validate: (value: unknown) => {
            const values = Array.isArray(value) ? (value as string[]) : []
            if (values.length !== 1) {
                return { issues: [{ message: "expected a single message argument" }] }
            }
            return { value: values[0] as string }
        }
    }
}

const command = defineCommand({
    name: "os-notify",
    description: "Raise an OS-wide desktop notification (macOS/Linux).",
    arguments: [
        { name: "message", description: "the notification body", required: true, variadic: true, schema: messageSchema }
    ],
    options: [
        {
            name: "title",
            arity: 1,
            hint: "title",
            description: "notification title",
            defaultValue: () => DEFAULT_TITLE
        },
        { name: "verbose", arity: 0, description: "report the chosen mechanism on stderr" }
    ],
    run: async ({ message, title, verbose }) => {
        const mechanism = await notify(message, title)
        if (mechanism === null) {
            // No notifier available -> exit 1, but don't lose the message: echo to
            // stderr. cmdore's thin tail otherwise returns 0, so force it here.
            process.stderr.write(`notify: no desktop notification mechanism available; ${title}: ${message}\n`)
            process.exit(1)
        }
        if (verbose) {
            process.stderr.write(`notify: ${mechanism}\n`)
        }
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
