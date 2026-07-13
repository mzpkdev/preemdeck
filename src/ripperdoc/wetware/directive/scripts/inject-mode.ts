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
import { throttle } from "../../../../common/hooks"
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

/** Default cadence: inject on a session's 1st prompt, then every Nth — the same throttle imprint's full template uses. */
export const DEFAULT_EVERY = 5

/** Default first-fire turn: a session's 1st prompt (so first + every = 1st, then every Nth). Overridable via `--first`. */
export const DEFAULT_FIRST = 1

/**
 * Value of the first/only `--every`, or null when absent or not a positive
 * integer (so the caller falls back to {@link DEFAULT_EVERY}). Never throws.
 */
export const extractEvery = (argv: string[]): number | null => {
    try {
        const raw = argvex({ argv, schema: [{ name: "every", arity: 1 }] }).every?.[0]
        const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10)
        return Number.isInteger(n) && n > 0 ? n : null
    } catch {
        return null
    }
}

/**
 * Value of the first/only `--first` (the turn of the first fire), or null when
 * absent or not a positive integer (so the caller falls back to {@link DEFAULT_FIRST}).
 * Never throws.
 */
export const extractFirst = (argv: string[]): number | null => {
    try {
        const raw = argvex({ argv, schema: [{ name: "first", arity: 1 }] }).first?.[0]
        const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10)
        return Number.isInteger(n) && n > 0 ? n : null
    } catch {
        return null
    }
}

/**
 * The render gate: emit the concatenated directive `bodies` only on a
 * throttle-cadence prompt (turn `first`, then every `every`th), a no-op between.
 * Keeps the directive from re-injecting its full body every turn — the same cadence
 * imprint's full template runs, but with no digest companion.
 */
export const renderGate =
    (bodies: string | null, every: number, first = 1) =>
    (payload: Record<string, unknown>): string | null =>
        bodies && throttle(payload, every, first) ? bodies : null

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
    const argv = Bun.argv.slice(2)
    const cliEvent = extractEvent(argv)
    if (cliEvent === null || cliEvent.length === 0) {
        process.stderr.write("usage: inject-mode --event <name> [--every <n>] [--first <n>]\n")
        process.exit(2)
    }
    const every = extractEvery(argv) ?? DEFAULT_EVERY
    const first = extractFirst(argv) ?? DEFAULT_FIRST
    const skillsDir = join(ENV.PLUGIN_ROOT, "skills")
    const bodies = await renderBodies(skillsDir)
    await runInjectionHook({
        event: cliEvent,
        render: renderGate(bodies, every, first)
    })
    process.exit(0)
}
