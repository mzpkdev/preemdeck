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

/** Inject on a session's 1st prompt, then every Nth. */
const EVERY = 5

/**
 * Pull `--event <name>` out of argv; return [event_or_null, positionals]. Never
 * throws. Only the first `--event` is honored; the positionals are every operand
 * regardless of where they sit relative to the flag.
 */
export const extractEventArg = (argv: string[]): [string | null, string[]] => {
    try {
        const args = argvex({ argv, schema: [{ name: "event", arity: 1 }] })
        return [args.event?.[0] ?? null, args._]
    } catch {
        return [null, []]
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
    const [cliEvent, argv] = extractEventArg(Bun.argv.slice(2))
    if (cliEvent === null || cliEvent.length === 0) {
        process.stderr.write("usage: inject-hook --event <name> <template> [host-tools]\n")
        process.exit(2)
    }
    const text = await renderTemplate(argv)
    await runInjectionHook({
        event: cliEvent,
        render: (payload) => (text && throttle(payload, EVERY) ? text : null)
    })
    process.exit(0)
}
