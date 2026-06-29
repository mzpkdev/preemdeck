#!/usr/bin/env -S preemdeck-runtime
/**
 * inject-mode.ts — directive-routing hook.
 *
 * Reads preemdeck.json via common/preemdeck `config`, takes its `directive`
 * object (slot -> value; a bare string is a single legacy value), resolves each
 * active value to `skills/<value>/directive.md`, and injects the concatenated
 * (slot order, deduped) bodies via lib/hook.ts. A missing/malformed config, an
 * empty directive, or all-unknown values is a silent `{}` no-op. `--event <name>`
 * is the required host event; stdin's hook_event_name wins.
 *
 * Path resolution: SKILLS_DIR = <plugin-root>/skills.
 */

import { existsSync } from "node:fs"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import argvex from "argvex"
import { runInjectionHook } from "../../../../common/hook-inject"
import { type Config, config, ENV, markdown } from "../../../../common/preemdeck"

/** Active values from the config's `directive`, in slot order, deduped. */
export const selectVariants = (cfg: Config): string[] => {
    const { directive } = cfg
    let values: unknown[] = []
    if (typeof directive === "string") {
        values = [directive]
    } else if (directive) {
        values = Object.values(directive)
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
    const text = (await markdown.read(body)).trim()
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

/** Build the concatenated directive bodies for the active config, or null. */
export const renderBodies = async (skillsDir: string): Promise<string | null> => {
    let cfg: Config
    try {
        cfg = await config.read()
    } catch {
        return null
    }
    const bodies: string[] = []
    for (const v of selectVariants(cfg)) {
        const t = await loadModeText(skillsDir, v)
        if (t) bodies.push(t)
    }
    return bodies.length ? bodies.join("\n\n") : null
}

if (import.meta.main) {
    const cliEvent = extractEvent(Bun.argv.slice(2))
    if (cliEvent === null || cliEvent.length === 0) {
        process.stderr.write("usage: inject-mode --event <name>\n")
        process.exit(2)
    }
    const skillsDir = join(ENV.PLUGIN_ROOT, "skills")
    const bodies = await renderBodies(skillsDir)
    await runInjectionHook({
        event: cliEvent,
        render: () => bodies
    })
    process.exit(0)
}
