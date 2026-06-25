#!/usr/bin/env -S preemdeck-bun
/**
 * os-ding.ts — play a short notification "ding".
 *
 * macOS + Linux only (Windows/winsound already removed). Selects a host-native
 * mechanism by platform; falls back to the ASCII terminal bell so something always
 * fires. Wired as a Stop hook: it ignores stdin entirely. Best-effort — never
 * throws; the command always exits 0.
 *
 * The subprocess seam rides lib/proc.ts (argv-only, no shell), wrapped in cmdore's
 * `effect()` so `--dry-run` skips the real spawn yet still reports a mechanism. A
 * missing binary makes Bun.spawn throw, which `runCmd` catches -> false (matches
 * Python's subprocess FileNotFoundError -> False).
 */

import { defineCommand, effect, execute } from "cmdore"
import { spawn } from "../../../../lib/proc.ts"

// macOS: a built-in system sound that reads as a clean "ding".
const MACOS_SOUND = "/System/Library/Sounds/Glass.aiff"

/**
 * Linux fallback chain, in preference order: the first command whose binary
 * exists and exits 0 wins. Ordered so the most likely-present, most pleasant
 * player is tried first, degrading to raw ALSA playback as a last resort.
 */
export const LINUX_CANDIDATES: string[][] = [
    ["canberra-gtk-play", "--id", "bell"],
    ["paplay", "/usr/share/sounds/freedesktop/stereo/bell.oga"],
    ["paplay", "/usr/share/sounds/freedesktop/stereo/complete.oga"],
    ["aplay", "-q", "/usr/share/sounds/alsa/Front_Center.wav"]
]

/**
 * Run `cmd` to completion; resolve true iff it spawned and exited 0. A missing
 * binary, non-zero exit, or timeout all resolve false. Never throws.
 *
 * The spawn rides `effect()`, so under `--dry-run` it is skipped and resolves to
 * `undefined` — treated here as "the command fired" so dry-run reports a real
 * mechanism without launching a player.
 */
export const runCmd = async (cmd: string[]): Promise<boolean> => {
    try {
        const result = (await effect(() => spawn(cmd, { timeoutMs: 10_000 }))) as
            | Awaited<ReturnType<typeof spawn>>
            | undefined
        if (result === undefined) return true
        return !result.timedOut && result.exitCode === 0
    } catch {
        return false
    }
}

/** Write the ASCII BEL ("\a") to stderr — the universal last-resort "ding". */
export const terminalBell = (): void => {
    process.stderr.write("\x07")
}

/** macOS: afplay a built-in sound; fall back to an osascript beep; else null. */
export const dingMacos = async (run: (cmd: string[]) => Promise<boolean> = runCmd): Promise<string | null> => {
    if (await run(["afplay", MACOS_SOUND])) return "afplay"
    if (await run(["osascript", "-e", "beep"])) return "osascript"
    return null
}

/** Linux: the first candidate player that's installed and exits 0; else null. */
export const dingLinux = async (run: (cmd: string[]) => Promise<boolean> = runCmd): Promise<string | null> => {
    for (const cmd of LINUX_CANDIDATES) {
        if (await run(cmd)) return cmd[0] as string
    }
    return null
}

/** The per-OS mechanism for the current platform (null worker on exotic OSes). */
export const platformWorker = (
    platform: string = process.platform,
    run: (cmd: string[]) => Promise<boolean> = runCmd
): (() => Promise<string | null>) => {
    if (platform === "darwin") return () => dingMacos(run)
    if (platform === "linux") return () => dingLinux(run)
    return async () => null // exotic platform: no native mechanism, fall to bell
}

/**
 * Play the host OS's "ding" and report which mechanism fired. Tries the
 * platform-native player first; when none is available it rings the ASCII
 * terminal bell as the floor, so a mechanism always fires.
 *
 * @returns the mechanism name (e.g. "afplay"), or "bell" when nothing native worked.
 *
 * @example
 * await ding() // "afplay" on a Mac, or "bell" if no player is installed
 */
export const ding = async (
    worker: () => Promise<string | null> = platformWorker(),
    bell: () => void = terminalBell
): Promise<string> => {
    const mechanism = await worker()
    if (mechanism === null) {
        bell()
        return "bell"
    }
    return mechanism
}

const command = defineCommand({
    name: "os-ding",
    description: "Play a short notification ding (macOS/Linux), falling back to the terminal bell.",
    options: [{ name: "verbose", arity: 0, description: "report the chosen mechanism on stderr" }],
    run: async ({ verbose }) => {
        // Best-effort: a ding failing must never fail the Stop hook that drives
        // this, so swallow everything and let the process exit 0.
        try {
            const mechanism = await ding()
            if (verbose) {
                process.stderr.write(`ding: ${mechanism}\n`)
            }
        } catch {
            // ignore — the bell floor already tried; never fail the hook
        }
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
