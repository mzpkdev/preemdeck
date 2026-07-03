#!/usr/bin/env -S preemdeck-runtime
/**
 * inject-tab-name.ts — main-thread tab-naming directive injector.
 *
 * Mirrors the imprint's inject-hook.ts, but self-contained in dock/idea for plugin
 * independence and with no `{{host_tools}}` substitution. On the prompt-submit event
 * (Claude/Codex UserPromptSubmit, Gemini BeforeAgent) it reads a directive template
 * (TAB-NAME.md, positional) from the plugin root, strips it, and emits it as an
 * `additionalContext` envelope via the shared runInjectionHook — the host folds it
 * into the MAIN model's context for that turn. The model (which already holds full
 * session context) picks a 1-2 word slug and runs rename-tab.ts itself; our code
 * only injects the directive. The directive is CONDITIONAL (rename only when the
 * current name no longer fits), so injecting every turn does not churn the tab.
 *
 * Cadence: default every turn (`--every 1`), gated through the shared per-session
 * {@link throttle}; a missing/empty template or a stdin/throttle miss is a silent
 * `{}` no-op. `--event <name>` is the required host event (stdin's hook_event_name
 * wins). Never disrupts the host — a bad template just injects nothing.
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

/** Default cadence: inject on every turn. The directive is conditional, so per-turn is cheap. Overridable via `--every`. */
const DEFAULT_EVERY = 1

/**
 * Pull `--event <name>` and optional `--every <n>` out of argv; return them with the
 * leftover positionals. Never throws. Only the first occurrence of each flag is honored;
 * surplus values fall through to positionals. `every` is null when absent or not a
 * positive integer — the caller supplies the default. (Mirrors inject-hook.extractArgs.)
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
    const { event, every, positionals } = extractArgs(Bun.argv.slice(2))
    if (event === null || event.length === 0) {
        process.stderr.write("usage: inject-tab-name --event <name> [--every <n>] <template>\n")
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
