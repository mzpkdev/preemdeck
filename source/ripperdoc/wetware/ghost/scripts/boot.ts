#!/usr/bin/env -S preemdeck-runtime
/**
 * boot.ts — SessionStart persona injector.
 *
 * Reads engram + firmware sources (base64 `.dat` preferred, else `.md`) from the
 * plugin root, concatenates the non-empty stripped bodies with a blank line, and
 * emits the standard context-injection envelope via lib/hook.ts. A missing/empty
 * persona is a silent `{}` no-op. Default event SessionStart; stdin wins.
 */

import { runInjectionHook } from "../../../../common/hook-inject"
import { ENV, markdown } from "../../../../common/preemdeck"
import { readSource } from "./codec"

const DEFAULT_EVENT = "SessionStart"

/** Build the combined persona text (engram + firmware), or "" when empty. */
export const combinedPersona = async (root: string): Promise<string> => {
    const engram = await readSource(root, "engram.dat", "ENGRAM.md")
    const firmware = await readSource(root, "firmware.dat", "FIRMWARE.md")
    return markdown.join(engram ?? "", firmware ?? "")
}

if (import.meta.main) {
    const persona = await combinedPersona(ENV.PLUGIN_ROOT)
    await runInjectionHook({
        event: DEFAULT_EVENT,
        render: () => persona || null
    })
    process.exit(0)
}
