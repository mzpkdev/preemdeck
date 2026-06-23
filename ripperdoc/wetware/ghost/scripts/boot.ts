#!/usr/bin/env -S preemdeck-bun
/**
 * boot.ts — SessionStart persona injector (port of boot.py).
 *
 * Reads engram + firmware sources (base64 `.dat` preferred, else `.md`) from the
 * plugin root, concatenates the non-empty stripped bodies with a blank line, and
 * emits the standard context-injection envelope via lib/hook.ts. A missing/empty
 * persona is a silent `{}` no-op. Default event SessionStart; stdin wins.
 *
 * PLUGIN_ROOT resolution mirrors boot.py: CLAUDE_PLUGIN_ROOT || PLUGIN_ROOT ||
 * the script dir's parent (scripts/ -> ghost/).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runInjectionHook } from "../../../../lib/inject.ts";

const DEFAULT_EVENT = "SessionStart";

/** The plugin root, resolved the same way as boot.py. */
export function pluginRoot(): string {
  return process.env.CLAUDE_PLUGIN_ROOT || process.env.PLUGIN_ROOT || dirname(import.meta.dir);
}

/**
 * Read a persona source: the base64 `.dat` if present (decoded), else the plain
 * `.md`, else null. Matches boot.py `read_source`.
 */
export function readSource(root: string, datName: string, mdName: string): string | null {
  const dat = join(root, datName);
  if (existsSync(dat)) {
    // .dat holds base64 ASCII; decode it to the original UTF-8 text.
    return Buffer.from(readFileSync(dat).toString("utf8"), "base64").toString("utf8");
  }
  const md = join(root, mdName);
  if (existsSync(md)) {
    return readFileSync(md, "utf8");
  }
  return null;
}

/** Build the combined persona text (engram + firmware), or "" when empty. */
export function combinedPersona(root: string): string {
  const parts: string[] = [];
  for (const [dat, md] of [
    ["engram.dat", "ENGRAM.md"],
    ["firmware.dat", "FIRMWARE.md"],
  ] as const) {
    const content = readSource(root, dat, md);
    if (content) {
      parts.push(content.trim());
    }
  }
  return parts.join("\n\n").trim();
}

if (import.meta.main) {
  const root = pluginRoot();
  await runInjectionHook({
    event: DEFAULT_EVENT,
    render: () => combinedPersona(root) || null,
  });
  process.exit(0);
}
