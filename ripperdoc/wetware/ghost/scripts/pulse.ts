#!/usr/bin/env -S preemdeck-bun
/**
 * pulse.ts — UserPromptSubmit persona-pulse injector (port of pulse.py).
 *
 * Reads the pulse source (base64 `pulse.dat` preferred, else `PULSE.md`) from the
 * plugin root and injects its stripped body via lib/hook.ts. Missing/empty is a
 * silent `{}` no-op. Default event UserPromptSubmit; stdin wins.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runInjectionHook } from "../../../../lib/inject.ts";

const DEFAULT_EVENT = "UserPromptSubmit";

/** The plugin root, resolved the same way as pulse.py. */
export const pluginRoot = (): string => {
  return process.env.CLAUDE_PLUGIN_ROOT || process.env.PLUGIN_ROOT || dirname(import.meta.dir);
};

/**
 * Read the pulse source: base64 `.dat` if present (decoded), else the plain
 * `.md`, else null. Matches pulse.py `read_source`.
 */
export const readSource = (root: string, datName: string, mdName: string): string | null => {
  const dat = join(root, datName);
  if (existsSync(dat)) {
    return Buffer.from(readFileSync(dat).toString("utf8"), "base64").toString("utf8");
  }
  const md = join(root, mdName);
  if (existsSync(md)) {
    return readFileSync(md, "utf8");
  }
  return null;
};

if (import.meta.main) {
  const root = pluginRoot();
  await runInjectionHook({
    event: DEFAULT_EVENT,
    render: () => {
      const content = readSource(root, "pulse.dat", "PULSE.md");
      if (!content) return null;
      return content.trim();
    },
  });
  process.exit(0);
}
