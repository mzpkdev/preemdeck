#!/usr/bin/env -S preemdeck-bun
/**
 * show-mode.ts — print a directive body verbatim (port of show_mode.py).
 *
 * Read-only: never touches preemdeck.json. Prints skills/<value>/directive.md
 * exactly as it ships, no framing. <value> must be a bare name (the same
 * anti-traversal guard inject_mode uses). Same input -> same bytes.
 *
 * Exit codes: 0 printed; 2 usage error, unsafe value, or no matching directive.md.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { pyName } from "./pyname.ts";

const SKILLS_DIR = join(dirname(import.meta.dir), "skills");

/** Sorted mode names — skill folders that ship a `directive.md`. */
export const availableModes = (skillsDir: string): string[] => {
  if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) return [];
  const names: string[] = [];
  for (const entry of readdirSync(skillsDir)) {
    const dir = join(skillsDir, entry);
    if (
      statSync(dir).isDirectory() &&
      existsSync(join(dir, "directive.md")) &&
      statSync(join(dir, "directive.md")).isFile()
    ) {
      names.push(entry);
    }
  }
  return names.sort();
};

/**
 * The CLI entry: validate <value> against the bare-name guard, then print its
 * directive body verbatim. Returns the process exit code (0 printed; 2 on usage
 * error, an unsafe value, or no matching directive.md) so callers stay testable.
 */
export const main = (
  argv: string[],
  skillsDir: string = SKILLS_DIR,
  write: (s: string) => void = (s) => process.stdout.write(s),
): number => {
  const modes = availableModes(skillsDir);
  const listing = modes.join(", ") || "none";
  if (argv.length !== 1 || !argv[0] || argv[0].trim() === "") {
    process.stderr.write(`usage: show_mode.py <value>   (values: ${listing})\n`);
    return 2;
  }
  const value = (argv[0] as string).trim();
  if (pyName(value) !== value) {
    process.stderr.write(`unsafe value ${pyRepr(value)}; available: ${listing}\n`);
    return 2;
  }
  const body = join(skillsDir, value, "directive.md");
  if (!existsSync(body) || !statSync(body).isFile()) {
    process.stderr.write(`unknown value ${pyRepr(value)}; available: ${listing}\n`);
    return 2;
  }
  write(readFileSync(body, "utf8"));
  return 0;
};

/** Render a string the way Python's `{value!r}` does for the common cases. */
const pyRepr = (value: string): string => {
  if (!value.includes("'") || value.includes('"')) return `'${value}'`;
  return `"${value}"`;
};

if (import.meta.main) {
  process.exit(main(Bun.argv.slice(2)));
}
