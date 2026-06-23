#!/usr/bin/env -S preemdeck-bun
/**
 * inject_mode.ts — directive-routing hook (port of inject_mode.py).
 *
 * Walks up from the script dir to find preemdeck.json, reads its `directive`
 * object (slot -> value; a bare string is a single legacy value), resolves each
 * active value to `skills/<value>/directive.md`, and injects the concatenated
 * (slot order, deduped) bodies via lib/hook.ts. A missing config / empty directive
 * / all-unknown values is a silent `{}` no-op. Default event UserPromptSubmit;
 * `--event <name>` is the fallback; stdin's hook_event_name wins.
 *
 * Path resolution mirrors the Python: SKILLS_DIR = <script-dir>/../skills.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { runInjectionHook } from "../../../../lib/inject.ts";
import { pyName } from "./pyname.ts";

const CONFIG_NAME = "preemdeck.json";
const DIRECTIVE_KEY = "directive";

const SEARCH_START = import.meta.dir;
const SKILLS_DIR = join(dirname(import.meta.dir), "skills");

/** Walk up from `start` (inclusive) toward the root; first preemdeck.json wins. */
export function findConfig(start: string): string | null {
  let dir = start;
  for (;;) {
    const candidate = join(dir, CONFIG_NAME);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Active values from the config's `directive` field, in slot order, deduped. */
export function selectVariants(config: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(config, "utf8"));
  } catch {
    return [];
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return [];
  const field = (data as Record<string, unknown>)[DIRECTIVE_KEY];
  let values: unknown[];
  if (typeof field === "string") {
    values = [field];
  } else if (field !== null && typeof field === "object" && !Array.isArray(field)) {
    values = Object.values(field as Record<string, unknown>);
  } else {
    return [];
  }
  const out: string[] = [];
  for (const v of values) {
    if (typeof v === "string" && v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Load `skills/<value>/directive.md`; null if unknown, empty, or unsafe.
 * `value` must be a bare name (no path separator / dot-segment) so a config value
 * can't escape the skills dir.
 */
export function loadModeText(skillsDir: string, value: string): string | null {
  if (pyName(value) !== value) return null;
  const body = join(skillsDir, value, "directive.md");
  if (!existsSync(body) || !statSync(body).isFile()) return null;
  const text = readFileSync(body, "utf8").trim();
  return text || null;
}

/** Return the value following the first `--event` flag, or null. */
export function extractEvent(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--event" && i + 1 < argv.length) return argv[i + 1] as string;
  }
  return null;
}

/** Build the concatenated directive bodies for the active config, or "" / null. */
export function renderBodies(searchStart: string, skillsDir: string): string | null {
  const config = findConfig(searchStart);
  if (config === null) return null;
  const bodies: string[] = [];
  for (const v of selectVariants(config)) {
    const t = loadModeText(skillsDir, v);
    if (t) bodies.push(t);
  }
  if (bodies.length === 0) return null;
  return bodies.join("\n\n");
}

if (import.meta.main) {
  const cliEvent = extractEvent(Bun.argv.slice(2));
  await runInjectionHook({
    event: cliEvent ?? undefined,
    render: () => renderBodies(SEARCH_START, SKILLS_DIR),
  });
  process.exit(0);
}
