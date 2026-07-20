#!/usr/bin/env -S preemdeck-runtime
/**
 * inject-tab-name.ts — main-thread tab-naming directive injector.
 *
 * Mirrors the imprint's inject-hook.ts, but self-contained in dock/idea for plugin
 * independence and with no `{{host_tools}}` substitution. On the prompt-submit event
 * (Claude/Codex UserPromptSubmit, Gemini BeforeAgent) it reads a directive template
 * (triggers/RENAME_TAB_TRIGGER.md, positional) from the plugin root, strips it, appends the tab's
 * CURRENT name (read back from the IDE, glyph-stripped, so the model can judge
 * whether it still fits), and emits it as an `additionalContext` envelope via the
 * shared runInjectionHook — the host folds it into the MAIN model's context for that
 * turn. The model (which already holds full session context) picks a 1-2 word slug
 * and runs rename-tab.ts itself; our code only injects the directive. The directive
 * is CONDITIONAL (rename only when the current name no longer fits), so injecting
 * does not churn the tab.
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
import { stripGlyph } from "../../tmux/toolbox/tmux-title"
import { inIdea, readTabTitle, resolveTabTargets, type TabTargets } from "./core"

/** Default cadence: inject on every turn. The directive is conditional, so per-turn is cheap. Overridable via `--every`. */
const DEFAULT_EVERY = 1

/** Default first-fire turn: a session's 1st prompt. Overridable via `--first`. */
const DEFAULT_FIRST = 1

/**
 * Pull `--event <name>` and optional `--every <n>` / `--first <n>` out of argv; return
 * them with the leftover positionals. Never throws. Only the first occurrence of each
 * flag is honored; surplus values fall through to positionals. `every` (cadence) and
 * `first` (the turn of the first fire) are null when absent or not a positive integer —
 * the caller supplies the defaults. (Mirrors inject-hook.extractArgs.)
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

/** Injectable IDE seams for {@link currentTabName}; production uses core inIdea / pid / title read. */
export type CurrentTabNameDeps = {
    inIdea: () => boolean
    resolveTabTargets: () => Promise<TabTargets>
    readTabTitle: (targets: TabTargets) => Promise<string | null>
}

const DEFAULT_TAB_DEPS: CurrentTabNameDeps = { inIdea, resolveTabTargets, readTabTitle }

/**
 * The tab's current base name: its displayed title read back from the IDE,
 * glyph-stripped. null when not in a JetBrains terminal, no pid resolves, the title
 * can't be read, or it strips to empty. NEVER throws — every failure is a null so
 * the injector simply omits the "current name" line. `deps` injects the IDE seams
 * for hermetic tests.
 */
export const currentTabName = async (deps: CurrentTabNameDeps = DEFAULT_TAB_DEPS): Promise<string | null> => {
    try {
        if (!deps.inIdea()) return null
        const targets = await deps.resolveTabTargets()
        if (targets.pids.length === 0 && targets.termSessionIds.length === 0) return null
        const title = await deps.readTabTitle(targets)
        const base = title ? stripGlyph(title) : ""
        return base.length > 0 ? base : null
    } catch {
        return null
    }
}

/**
 * Append a line naming the tab's current title to the directive so the model can
 * judge whether it still fits before renaming. A null name (unreadable, or the tab
 * is auto-named to nothing usable) leaves the directive untouched.
 */
export const appendTabName = (text: string, name: string | null): string =>
    name ? `${text}\n\nThis tab is currently named \`${name}\`.` : text

if (import.meta.main) {
    const { event, every, first, positionals } = extractArgs(Bun.argv.slice(2))
    if (event === null || event.length === 0) {
        process.stderr.write("usage: inject-tab-name --event <name> [--every <n>] [--first <n>] <template>\n")
        process.exit(2)
    }
    const text = await renderTemplate(positionals)
    const cadence = every ?? DEFAULT_EVERY
    const firstAt = first ?? DEFAULT_FIRST
    await runInjectionHook({
        event,
        // Resolve the current name only when the throttle fires (an IDE round-trip),
        // so no-op turns stay cheap; a null name just omits the extra line.
        render: async (payload) =>
            text && throttle(payload, cadence, firstAt) ? appendTabName(text, await currentTabName()) : null
    })
    process.exit(0)
}
