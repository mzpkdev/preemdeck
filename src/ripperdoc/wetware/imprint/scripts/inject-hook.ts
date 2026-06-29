#!/usr/bin/env -S preemdeck-runtime
/**
 * inject-hook.ts — imprint-template context injector.
 *
 * Resolves a template (positional path), reads it
 * from the plugin root, substitutes the optional host-tools file's contents for
 * `{{host_tools}}`, strips, and injects via lib/hook.ts. Missing/empty files are a
 * silent `{}` no-op; a missing host-tools file substitutes empty. `--event <name>`
 * (first only) is the required host event; stdin wins.
 *
 * Path note: args resolve as `pluginRoot / arg` with an "absolute arg wins"
 * rule — Node's `resolve()` honors absolute temp paths verbatim. `pluginRoot`
 * defaults to ENV.PLUGIN_ROOT (the .../ripperdoc/<rack>/<plugin> of the running
 * hook); tests pass it explicitly.
 */

import { existsSync } from "node:fs"
import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import argvex from "argvex"
import { runInjectionHook } from "../../../../common/hook-inject"
import { throttle } from "../../../../common/hooks"
import { ENV, markdown } from "../../../../common/preemdeck"

/** Default cadence: inject on a session's 1st prompt, then every Nth. Overridable per hook via `--every`. */
const DEFAULT_EVERY = 5

/**
 * Pull `--event <name>` and optional `--every <n>` out of argv; return them with the
 * leftover positionals. Never throws. Only the first occurrence of each flag is honored;
 * surplus values fall through to positionals. `every` is null when absent or not a
 * positive integer — the caller supplies the default.
 */
export const extractArgs = (argv: string[]): { event: string | null; every: number | null; positionals: string[] } => {
    try {
        const args = argvex({
            argv,
            schema: [
                { name: "event", arity: 1 },
                { name: "every", arity: 1 }
            ]
        })
        const everyRaw = args.every?.[0]
        const every = everyRaw === undefined ? Number.NaN : Number.parseInt(everyRaw, 10)
        return {
            event: args.event?.[0] ?? null,
            every: Number.isInteger(every) && every > 0 ? every : null,
            positionals: args._
        }
    } catch {
        return { event: null, every: null, positionals: [] }
    }
}

const isFile = async (path: string): Promise<boolean> => {
    return existsSync(path) && (await stat(path)).isFile()
}

/**
 * Build the injected text from argv (the script's tail). Returns the stripped
 * text, or null for any no-op (no template arg, missing/empty template, empty
 * after substitution+strip). `pluginRoot` defaults to the running hook's plugin root.
 */
export const renderTemplate = async (argv: string[], pluginRoot: string = ENV.PLUGIN_ROOT): Promise<string | null> => {
    const [templateRel, ...rest] = argv
    if (!templateRel) return null

    const promptPath = resolve(pluginRoot, templateRel)
    if (!(await isFile(promptPath))) return null
    const template = await markdown.read(promptPath)

    let hostTools = ""
    if (rest.length > 0) {
        const hostPath = resolve(pluginRoot, rest[0] as string)
        if (await isFile(hostPath)) {
            hostTools = (await markdown.read(hostPath)).trim()
        }
    }

    const text = markdown.interpolate(template, { host_tools: hostTools }).trim()
    return text || null
}

if (import.meta.main) {
    const { event, every, positionals } = extractArgs(Bun.argv.slice(2))
    if (event === null || event.length === 0) {
        process.stderr.write("usage: inject-hook --event <name> [--every <n>] <template> [host-tools]\n")
        process.exit(2)
    }
    const text = await renderTemplate(positionals)
    const cadence = every ?? DEFAULT_EVERY
    await runInjectionHook({
        event,
        render: (payload) => (text && throttle(payload, cadence) ? text : null)
    })
    process.exit(0)
}
