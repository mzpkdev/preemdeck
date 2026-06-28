#!/usr/bin/env -S preemdeck-runtime
/**
 * inject-mode.ts — directive-routing hook.
 *
 * Walks up from the script dir to find preemdeck.json, reads its `directive`
 * object (slot -> value; a bare string is a single legacy value), resolves each
 * active value to `skills/<value>/directive.md`, and injects the concatenated
 * (slot order, deduped) bodies via lib/hook.ts. A missing config / empty directive
 * / all-unknown values is a silent `{}` no-op. `--event <name>` is the required
 * host event; stdin's hook_event_name wins.
 *
 * Path resolution: SKILLS_DIR = <script-dir>/../skills.
 */

import { existsSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import argvex from "argvex"
import { runInjectionHook } from "../../../../common/hook-inject"

const CONFIG_NAME = "preemdeck.json"
const DIRECTIVE_KEY = "directive"

const SEARCH_START = import.meta.dir
const SKILLS_DIR = join(dirname(import.meta.dir), "skills")

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

/** Active values from the config's `directive` field, in slot order, deduped. */
export const selectVariants = async (config: string): Promise<string[]> => {
    let data: unknown
    try {
        data = JSON.parse(await readFile(config, "utf8"))
    } catch {
        return []
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) return []
    const field = (data as Record<string, unknown>)[DIRECTIVE_KEY]
    let values: unknown[]
    if (typeof field === "string") {
        values = [field]
    } else if (field !== null && typeof field === "object" && !Array.isArray(field)) {
        values = Object.values(field as Record<string, unknown>)
    } else {
        return []
    }
    const out: string[] = []
    for (const v of values) {
        if (typeof v === "string" && v && !out.includes(v)) out.push(v)
    }
    return out
}

/**
 * Load `skills/<value>/directive.md`; null if unknown, empty, or unsafe.
 * `value` must be a bare name (no path separator / dot-segment) so a config value
 * can't escape the skills dir.
 */
export const loadModeText = async (skillsDir: string, value: string): Promise<string | null> => {
    if (value.includes("/") || value === ".") return null
    const body = join(skillsDir, value, "directive.md")
    if (!existsSync(body) || !(await stat(body)).isFile()) return null
    const text = (await readFile(body, "utf8")).trim()
    return text || null
}

/** Value of the first/only `--event`, or null. Never throws. */
export const extractEvent = (argv: string[]): string | null => {
    try {
        return argvex({ argv, schema: [{ name: "event", arity: 1 }] }).event?.[0] ?? null
    } catch {
        return null
    }
}

/** Build the concatenated directive bodies for the active config, or "" / null. */
export const renderBodies = async (searchStart: string, skillsDir: string): Promise<string | null> => {
    const config = await findConfig(searchStart)
    if (config === null) return null
    const bodies: string[] = []
    for (const v of await selectVariants(config)) {
        const t = await loadModeText(skillsDir, v)
        if (t) bodies.push(t)
    }
    if (bodies.length === 0) return null
    return bodies.join("\n\n")
}

if (import.meta.main) {
    const cliEvent = extractEvent(Bun.argv.slice(2))
    if (cliEvent === null || cliEvent.length === 0) {
        process.stderr.write("usage: inject-mode --event <name>\n")
        process.exit(2)
    }
    const bodies = await renderBodies(SEARCH_START, SKILLS_DIR)
    await runInjectionHook({
        event: cliEvent,
        render: () => bodies
    })
    process.exit(0)
}
