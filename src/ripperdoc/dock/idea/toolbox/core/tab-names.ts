/**
 * tab-names.ts — a tiny persisted map of stable-tab-id -> chosen tab-name slug.
 *
 * Backs main-thread-injection tab naming: a UserPromptSubmit directive (TAB-NAME.md,
 * folded into the main model's context by inject-tab-name.ts) has the model pick a
 * 1-2 word slug and run rename-tab.ts, which records it here keyed by the tab's
 * stable id (the tmux session name when in tmux, else the controlling tty — see
 * tab-pids.ts `tabKey`). tab-title.ts then reuses the saved slug as the label base,
 * so a glyph flip (idle/busy/waiting) preserves the model's name instead of
 * reverting to the bare project label; the `reset` state clears it.
 *
 * Stored as a flat `{ key: slug }` JSON object at `~/.preemdeck/tab-names.json`.
 * Best-effort + NEVER throws: a missing/malformed file reads as an empty map, and
 * any write failure (read-only fs, a race) is swallowed — a lost name is a cosmetic
 * miss, never a crash inside the silent tab-title hook or the rename-tab CLI.
 *
 * The backing file path is injectable (the `file` parameter) so tests point it at a
 * throwaway path; it defaults to {@link savedNamesPath}, resolved per call so an
 * ENV.PREEMDECK_ROOT override (or a `$HOME` redirect) is honored.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { ENV } from "../../../../../common/preemdeck"

/** `~/.preemdeck/tab-names.json` — resolved per call so a PREEMDECK_ROOT/`$HOME` test override is honored. */
export const savedNamesPath = (): string => join(ENV.PREEMDECK_ROOT, "tab-names.json")

/** Parse the `{ key: slug }` map at `file`; an absent, malformed, or non-object file reads as `{}`. Never throws. */
const readMap = (file: string): Record<string, string> => {
    try {
        const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return {}
        }
        const out: Record<string, string> = {}
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v === "string" && v.length > 0) out[k] = v
        }
        return out
    } catch {
        return {}
    }
}

/**
 * Write `map` to `file` as atomically as a hook can manage: a pid-tagged temp
 * sibling, then a rename over the target (atomic on POSIX). Any failure — a
 * read-only fs or a racing writer — is swallowed; persistence is best-effort.
 */
const writeMap = (file: string, map: Record<string, string>): void => {
    try {
        mkdirSync(dirname(file), { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`)
        renameSync(tmp, file)
    } catch {
        // A read-only or racing filesystem must not break the caller; skip persistence.
    }
}

/**
 * The saved slug for `key`, or undefined when none is stored (or `key` is empty —
 * an empty key means no stable tab id resolved, so there is nothing to look up).
 * Never throws.
 */
export const getSavedName = (key: string, file: string = savedNamesPath()): string | undefined => {
    if (key.length === 0) return undefined
    return readMap(file)[key]
}

/**
 * Persist `slug` as the saved name for `key`. A no-op for an empty key or empty
 * slug (nothing usable to store). Read-modify-write so other keys survive. Never throws.
 */
export const setSavedName = (key: string, slug: string, file: string = savedNamesPath()): void => {
    if (key.length === 0 || slug.length === 0) return
    const map = readMap(file)
    map[key] = slug
    writeMap(file, map)
}

/** Drop the saved name for `key` (a no-op when the key is empty or absent). Never throws. */
export const clearSavedName = (key: string, file: string = savedNamesPath()): void => {
    if (key.length === 0) return
    const map = readMap(file)
    if (!(key in map)) return
    delete map[key]
    writeMap(file, map)
}
