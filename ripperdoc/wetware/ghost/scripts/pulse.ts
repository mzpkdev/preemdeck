#!/usr/bin/env -S preemdeck-bun
/**
 * pulse.ts — UserPromptSubmit persona-pulse injector.
 *
 * Reads the pulse source (base64 `pulse.dat` preferred, else `PULSE.md`) from the
 * plugin root and injects its stripped body via lib/hook.ts. Missing/empty is a
 * silent `{}` no-op. Default event UserPromptSubmit; stdin wins.
 */

import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { exists } from "../../../../lib/fs.ts"
import { runInjectionHook } from "../../../../lib/inject.ts"

const DEFAULT_EVENT = "UserPromptSubmit"

/** The plugin root: CLAUDE_PLUGIN_ROOT || PLUGIN_ROOT || the script dir's parent. */
export const pluginRoot = (): string => {
  return process.env.CLAUDE_PLUGIN_ROOT || process.env.PLUGIN_ROOT || dirname(import.meta.dir)
}

/**
 * Read the pulse source: base64 `.dat` if present (decoded), else the plain
 * `.md`, else null.
 */
export const readSource = async (root: string, datName: string, mdName: string): Promise<string | null> => {
  const dat = join(root, datName)
  if (await exists(dat)) {
    return Buffer.from((await readFile(dat)).toString("utf8"), "base64").toString("utf8")
  }
  const md = join(root, mdName)
  if (await exists(md)) {
    return await readFile(md, "utf8")
  }
  return null
}

if (import.meta.main) {
  const root = pluginRoot()
  const content = await readSource(root, "pulse.dat", "PULSE.md")
  await runInjectionHook({
    event: DEFAULT_EVENT,
    render: () => {
      if (!content) return null
      return content.trim()
    },
  })
  process.exit(0)
}
