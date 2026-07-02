/**
 * config.ts — read/write the user-local preemdeck.json (channel + directive state).
 *
 * `seedConfig` seeds the built-in defaults if absent (never clobbering user edits);
 * `recordChannel` persists the resolved channel on every install; `readChannel`
 * (consolidated here from update.ts) reads it back so update forwards the same stream.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Channel, Config } from "../common/preemdeck"
import { CONFIG_FILE, DEFAULT_CONFIG } from "./constants"
import { DIM, RESET, sub } from "./skin"

/**
 * Write the user-local preemdeck.json from the built-in DEFAULT_CONFIG, if absent.
 *
 * preemdeck.json is gitignored (the directive object); the defaults live in this
 * install script, not a tracked file. Seed-if-absent: create it on first install, NEVER
 * overwrite an existing one — so set-mode.ts's writes persist across re-installs
 * (gitignored => a re-clone leaves it alone; this won't clobber it).
 */
export function seedConfig(repoRoot: string, dryRun: boolean): void {
    const dst = join(repoRoot, CONFIG_FILE)
    if (existsSync(dst)) {
        sub(`${CONFIG_FILE} ${DIM}present${RESET}`)
        return
    }
    if (dryRun) {
        sub(`${DIM}would seed ${CONFIG_FILE} with defaults${RESET}`)
        return
    }
    writeFileSync(dst, DEFAULT_CONFIG)
    sub(`${CONFIG_FILE} ${DIM}seeded with defaults${RESET}`)
}

/**
 * Persist the resolved release channel into preemdeck.json (read-modify-write, so the
 * user's `directive` survives). boot.sh fetched the channel named by PREEMDECK_CHANNEL
 * (its own default is stable), so install.ts mirrors that env here; update.ts reads it
 * back and forwards it, keeping `update` on the channel you installed with.
 *
 * Unlike seedConfig this writes on EVERY install — a channel SWITCH (edge→stable on a
 * later run) must overwrite the recorded value, which seed-if-absent never would.
 */
export function recordChannel(repoRoot: string, dryRun: boolean): void {
    const channel: Channel = process.env.PREEMDECK_CHANNEL === "edge" ? "edge" : "stable"
    if (dryRun) {
        sub(`${DIM}would record channel ${channel}${RESET}`)
        return
    }
    const dst = join(repoRoot, CONFIG_FILE)
    let data: Config = {}
    if (existsSync(dst)) {
        try {
            data = JSON.parse(readFileSync(dst, "utf8")) as Config
        } catch {
            data = {} // unparseable — seedConfig owns directive recovery; we just (re)set channel
        }
    }
    data.channel = channel
    writeFileSync(dst, `${JSON.stringify(data, null, 2)}\n`)
    sub(`channel ${DIM}${channel}${RESET}`)
}

/**
 * The channel this install tracks, read from preemdeck.json (install.ts persists it).
 * "stable"/"edge", or undefined when unset (pre-channel installs) or unreadable — the
 * caller then leaves PREEMDECK_CHANNEL alone so boot.sh applies its own stable default.
 */
export function readChannel(repoRoot: string): string | undefined {
    try {
        const data = JSON.parse(readFileSync(join(repoRoot, CONFIG_FILE), "utf8")) as { channel?: unknown }
        return data.channel === "edge" || data.channel === "stable" ? data.channel : undefined
    } catch {
        return undefined
    }
}
