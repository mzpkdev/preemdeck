#!/usr/bin/env -S preemdeck-runtime
/**
 * pulse.ts — UserPromptSubmit persona-pulse injector.
 *
 * Reads the pulse source (base64 `pulse.dat` preferred, else `PULSE.md`) from the
 * plugin root and injects its stripped body via lib/hook.ts. Missing/empty is a
 * silent `{}` no-op. Default event UserPromptSubmit; stdin wins.
 */

import { runInjectionHook } from "../../../../common/hook-inject"
import { ENV, markdown } from "../../../../common/preemdeck"
import { readSource } from "./codec"

const DEFAULT_EVENT = "UserPromptSubmit"

if (import.meta.main) {
    const content = await readSource(ENV.PLUGIN_ROOT, "pulse.dat", "PULSE.md")
    await runInjectionHook({
        event: DEFAULT_EVENT,
        render: () => markdown.join(content ?? "") || null
    })
    process.exit(0)
}
