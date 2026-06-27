#!/usr/bin/env -S preemdeck-bun
/**
 * boot.ts — SessionStart persona injector.
 *
 * Reads engram + firmware sources (base64 `.dat` preferred, else `.md`) from the
 * plugin root, concatenates the non-empty stripped bodies with a blank line, and
 * emits the standard context-injection envelope via lib/hook.ts. A missing/empty
 * persona is a silent `{}` no-op. Default event SessionStart; stdin wins.
 *
 * PLUGIN_ROOT resolution: the script dir's parent (scripts/ -> ghost/).
 */

import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { exists } from "../../../../lib/fs.ts"
import { runInjectionHook } from "../../../../lib/inject.ts"

const DEFAULT_EVENT = "SessionStart"

/** The plugin root: the script dir's parent (scripts/ -> ghost/). */
export const pluginRoot = (): string => {
    return dirname(import.meta.dir)
}

/**
 * Read a persona source: the base64 `.dat` if present (decoded), else the plain
 * `.md`, else null.
 */
export const readSource = async (root: string, datName: string, mdName: string): Promise<string | null> => {
    const dat = join(root, datName)
    if (await exists(dat)) {
        // .dat holds base64 ASCII; decode it to the original UTF-8 text.
        return Buffer.from((await readFile(dat)).toString("utf8"), "base64").toString("utf8")
    }
    const md = join(root, mdName)
    if (await exists(md)) {
        return await readFile(md, "utf8")
    }
    return null
}

/** Build the combined persona text (engram + firmware), or "" when empty. */
export const combinedPersona = async (root: string): Promise<string> => {
    const parts: string[] = []
    for (const [dat, md] of [
        ["engram.dat", "ENGRAM.md"],
        ["firmware.dat", "FIRMWARE.md"]
    ] as const) {
        const content = await readSource(root, dat, md)
        if (content) {
            parts.push(content.trim())
        }
    }
    return parts.join("\n\n").trim()
}

if (import.meta.main) {
    const root = pluginRoot()
    const persona = await combinedPersona(root)
    await runInjectionHook({
        event: DEFAULT_EVENT,
        render: () => persona || null
    })
    process.exit(0)
}
