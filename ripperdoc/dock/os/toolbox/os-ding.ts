#!/usr/bin/env -S preemdeck-bun
/**
 * os-ding.ts — play a short notification "ding".
 *
 * macOS + Linux only (Windows/winsound already removed). Selects a host-native
 * mechanism by platform; falls back to the ASCII terminal bell so something always
 * fires. Wired as a Stop hook: it ignores stdin entirely. Best-effort — never
 * throws; main always exits 0.
 *
 * The subprocess seam rides lib/proc.ts (argv-only, no shell). A missing binary
 * makes Bun.spawn throw, which `runCmd` catches -> false (matches Python's
 * subprocess FileNotFoundError -> False).
 */

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
  ["aplay", "-q", "/usr/share/sounds/alsa/Front_Center.wav"],
]

/**
 * Run `cmd` to completion; resolve true iff it spawned and exited 0. A missing
 * binary, non-zero exit, or timeout all resolve false. Never throws.
 */
export const runCmd = async (cmd: string[]): Promise<boolean> => {
  try {
    const result = await spawn(cmd, { timeoutMs: 10_000 })
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
  run: (cmd: string[]) => Promise<boolean> = runCmd,
): (() => Promise<string | null>) => {
  if (platform === "darwin") return () => dingMacos(run)
  if (platform === "linux") return () => dingLinux(run)
  return async () => null // exotic platform: no native mechanism, fall to bell
}

/** Play the host OS's "ding"; return the mechanism, or "bell" as the floor. */
export const ding = async (
  worker: () => Promise<string | null> = platformWorker(),
  bell: () => void = terminalBell,
): Promise<string> => {
  const mechanism = await worker()
  if (mechanism === null) {
    bell()
    return "bell"
  }
  return mechanism
}

/**
 * CLI entrypoint: play the ding and (when `-v`/`--verbose`) report the mechanism
 * on stderr. Always exits 0 — a ding failing is never worth failing the Stop hook
 * that drives this.
 */
export const main = async (argv: string[]): Promise<number> => {
  const verbose = argv.includes("-v") || argv.includes("--verbose")
  const mechanism = await ding()
  if (verbose) {
    process.stderr.write(`ding: ${mechanism}\n`)
  }
  return 0
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)))
}
