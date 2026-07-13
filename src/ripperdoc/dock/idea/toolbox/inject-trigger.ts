#!/usr/bin/env -S preemdeck-runtime
/**
 * inject-trigger.ts — generic trigger-directive injector for dock/idea.
 *
 * The plugin-independent sibling of inject-tab-name.ts: reads a trigger template
 * (positional, e.g. triggers/NOTIFY_TRIGGER.md) from the plugin root, strips it, and
 * emits it as an `additionalContext` envelope via the shared runInjectionHook,
 * throttle-gated per session. Unlike inject-tab-name.ts it appends nothing — a plain
 * directive routed into the model, which reads it and runs whatever the trigger asks.
 * `--event <name>` is the required host event (stdin's hook_event_name wins);
 * `--every`/`--first` set the cadence. A missing/empty template or a stdin/throttle
 * miss is a silent `{}` no-op. Never disrupts the host — a bad template injects nothing.
 *
 * It lives in dock/idea (not shared with imprint's inject-hook.ts) because
 * ENV.PLUGIN_ROOT resolves from the running script's path, so the template must be
 * read relative to the plugin whose hook fires it.
 *
 * Path note: the positional resolves as `pluginRoot / arg` with "absolute arg wins";
 * `pluginRoot` defaults to ENV.PLUGIN_ROOT (the .../ripperdoc/dock/idea of the running
 * hook), tests pass it explicitly.
 */

import { existsSync } from "node:fs"
import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import argvex from "argvex"
import { runInjectionHook } from "../../../../common/hook-inject"
import { throttle } from "../../../../common/hooks"
import { ENV, markdown } from "../../../../common/preemdeck"

/** Default cadence: inject on a session's 1st prompt, then every Nth. Overridable via `--every`. */
const DEFAULT_EVERY = 5

/** Default first-fire turn: a session's 1st prompt. Overridable via `--first`. */
const DEFAULT_FIRST = 1

/**
 * Pull `--event <name>` and optional `--every <n>` / `--first <n>` out of argv; return
 * them with the leftover positionals. Never throws. Only the first occurrence of each
 * flag is honored; surplus values fall through to positionals. `every` (cadence) and
 * `first` (the turn of the first fire) are null when absent or not a positive integer —
 * the caller supplies the defaults. (Mirrors inject-tab-name.extractArgs.)
 */
export const extractArgs = (
    argv: string[]
): { event: string | null; every: number | null; first: number | null; positionals: string[] } => {
    try {
        const args = argvex({
            argv,
            schema: [
                { name: "event", arity: 1 },
                { name: "every", arity: 1 },
                { name: "first", arity: 1 }
            ]
        })
        const everyRaw = args.every?.[0]
        const every = everyRaw === undefined ? Number.NaN : Number.parseInt(everyRaw, 10)
        const firstRaw = args.first?.[0]
        const first = firstRaw === undefined ? Number.NaN : Number.parseInt(firstRaw, 10)
        return {
            event: args.event?.[0] ?? null,
            every: Number.isInteger(every) && every > 0 ? every : null,
            first: Number.isInteger(first) && first > 0 ? first : null,
            positionals: args._
        }
    } catch {
        return { event: null, every: null, first: null, positionals: [] }
    }
}

const isFile = async (path: string): Promise<boolean> => {
    return existsSync(path) && (await stat(path)).isFile()
}

/**
 * Build the injected text from argv (the script's tail). Returns the stripped
 * template, or null for any no-op (no template arg, missing template, empty after
 * strip). `pluginRoot` defaults to the running hook's plugin root.
 */
export const renderTemplate = async (argv: string[], pluginRoot: string = ENV.PLUGIN_ROOT): Promise<string | null> => {
    const [templateRel] = argv
    if (!templateRel) return null

    const promptPath = resolve(pluginRoot, templateRel)
    if (!(await isFile(promptPath))) return null

    const text = (await markdown.read(promptPath)).trim()
    return text || null
}

if (import.meta.main) {
    const { event, every, first, positionals } = extractArgs(Bun.argv.slice(2))
    if (event === null || event.length === 0) {
        process.stderr.write("usage: inject-trigger --event <name> [--every <n>] [--first <n>] <template>\n")
        process.exit(2)
    }
    const text = await renderTemplate(positionals)
    const cadence = every ?? DEFAULT_EVERY
    const firstAt = first ?? DEFAULT_FIRST
    await runInjectionHook({
        event,
        render: (payload) => (text && throttle(payload, cadence, firstAt) ? text : null)
    })
    process.exit(0)
}
