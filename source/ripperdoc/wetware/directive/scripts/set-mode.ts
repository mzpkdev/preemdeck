#!/usr/bin/env -S preemdeck-runtime
/**
 * set-mode.ts — the deterministic preemdeck.json writer.
 *
 * The SOLE writer of preemdeck.json's `directive` object. <value> is validated
 * against the shipped mode skills (skills/<value>/directive.md); its slot is
 * DERIVED from scripts/modes.json (value->slot), so the value alone decides the
 * slot. preemdeck.json is found by walking up from this script; the derived slot
 * must already be present in the config's `directive` object; `directive[slot]` is
 * set, every other slot/top-level key preserved, and the file rewritten atomically
 * (tmp file + rename; 2-space indent + trailing newline). Same input -> same bytes.
 *
 * Exit codes: 0 slot set (idempotent); 2 usage / unknown value / no slot in
 * modes.json / missing-or-malformed modes.json / unknown derived slot / config
 * not found.
 */

import { existsSync } from "node:fs"
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { ENV } from "../../../../common/preemdeck"

const CONFIG_NAME = "preemdeck.json"
const DIRECTIVE_KEY = "directive"

const SEARCH_START = import.meta.dir
const MODES_FILE = join(import.meta.dir, "modes.json")

/** Walk up from `start` (inclusive) toward the root; first preemdeck.json wins. */
export const findConfig = async (start: string): Promise<string | null> => {
    let dir = start
    for (;;) {
        const candidate = join(dir, CONFIG_NAME)
        if (existsSync(candidate) && (await stat(candidate)).isFile()) return candidate
        const parent = dirname(dir)
        if (parent === dir) return null
        dir = parent
    }
}

/** Sorted mode names — skill folders that ship a `directive.md`. */
export const availableModes = async (skillsDir: string): Promise<string[]> => {
    if (!existsSync(skillsDir) || !(await stat(skillsDir)).isDirectory()) return []
    const names: string[] = []
    const entries = await readdir(skillsDir)
    for (const entry of entries) {
        const dir = join(skillsDir, entry)
        const body = join(dir, "directive.md")
        if ((await stat(dir)).isDirectory() && existsSync(body) && (await stat(body)).isFile()) {
            names.push(entry)
        }
    }
    return names.sort()
}

/** Raised for a missing/malformed modes.json — a hard error, distinct from no-entry. */
export class ModesError extends Error {}

/**
 * The slot a value maps to in modes.json; null if it has no (non-blank) entry.
 * Throws ModesError if modes.json is missing, unreadable, or not a JSON object.
 */
export const slotFor = async (modesFile: string, value: string): Promise<string | null> => {
    let data: unknown
    try {
        data = JSON.parse(await readFile(modesFile, "utf8"))
    } catch {
        throw new ModesError(`${modesFile} missing or malformed`)
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
        throw new ModesError(`${modesFile} missing or malformed`)
    }
    const slot = (data as Record<string, unknown>)[value]
    return typeof slot === "string" && slot.trim() ? slot : null
}

/** Slot keys already defined in the config's `directive` object (insertion order). */
export const configSlots = async (config: string): Promise<string[]> => {
    let data: unknown
    try {
        data = JSON.parse(await readFile(config, "utf8"))
    } catch {
        return []
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) return []
    const field = (data as Record<string, unknown>)[DIRECTIVE_KEY]
    if (field === null || typeof field !== "object" || Array.isArray(field)) return []
    return Object.keys(field as Record<string, unknown>)
}

/** Atomically write `data` as 2-space JSON + trailing newline: write a sibling
 *  `<path>.tmp`, then rename over `path` so a reader never sees a partial file. */
const writeJson = async (path: string, data: unknown): Promise<void> => {
    const tmp = `${path}.tmp`
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8")
    await rename(tmp, path)
}

/** Set `directive[slot] = value`, preserving other slots/keys; atomic write. */
export const setDirective = async (config: string, slot: string, value: string): Promise<void> => {
    let data: unknown
    try {
        data = JSON.parse(await readFile(config, "utf8"))
    } catch {
        data = {}
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) data = {}
    const obj = data as Record<string, unknown>
    let field = obj[DIRECTIVE_KEY]
    if (field === null || typeof field !== "object" || Array.isArray(field)) field = {}
    ;(field as Record<string, unknown>)[slot] = value
    obj[DIRECTIVE_KEY] = field
    await writeJson(config, obj)
}

/**
 * The CLI entry: validate <value>, derive its slot from modes.json, confirm the
 * slot exists in the resolved config, and write it. Returns the process exit code
 * (0 set/idempotent; 2 on any usage, lookup, or config error) instead of exiting,
 * so the suite can drive it directly. The injectable `opts` override the
 * module-level search/skills/modes paths for testing.
 */
export const main = async (
    argv: string[],
    opts: { searchStart?: string; skillsDir?: string; modesFile?: string } = {}
): Promise<number> => {
    const searchStart = opts.searchStart ?? SEARCH_START
    const skillsDir = opts.skillsDir ?? join(ENV.PLUGIN_ROOT, "skills")
    const modesFile = opts.modesFile ?? MODES_FILE

    const modes = await availableModes(skillsDir)
    const listing = modes.join(", ") || "none"
    if (argv.length !== 1 || !argv[0] || argv[0].trim() === "") {
        process.stderr.write(`usage: set-mode <value>   (values: ${listing})\n`)
        return 2
    }
    const value = (argv[0] as string).trim()
    if (!modes.includes(value)) {
        process.stderr.write(`unknown value "${value}"; available: ${listing}\n`)
        return 2
    }
    let slot: string | null
    try {
        slot = await slotFor(modesFile, value)
    } catch (exc) {
        process.stderr.write(`${exc instanceof Error ? exc.message : String(exc)}\n`)
        return 2
    }
    if (slot === null) {
        process.stderr.write(`mode "${value}" has no slot in modes.json\n`)
        return 2
    }
    const config = await findConfig(searchStart)
    if (config === null) {
        process.stderr.write(`${CONFIG_NAME} not found above ${searchStart}\n`)
        return 2
    }
    const slots = await configSlots(config)
    if (!slots.includes(slot)) {
        const slisting = slots.join(", ") || "none"
        process.stderr.write(`unknown slot "${slot}"; defined slots: ${slisting}\n`)
        return 2
    }
    await setDirective(config, slot, value)
    process.stdout.write(`${DIRECTIVE_KEY}.${slot} = ${value}  (${config})\n`)
    return 0
}

if (import.meta.main) {
    process.exit(await main(Bun.argv.slice(2)))
}
