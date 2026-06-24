#!/usr/bin/env -S preemdeck-bun
/**
 * show-mode.ts — print a directive body verbatim.
 *
 * Read-only: never touches preemdeck.json. Prints skills/<value>/directive.md
 * exactly as it ships, no framing. <value> must be a bare name (the same
 * anti-traversal guard inject-mode uses). Same input -> same bytes.
 *
 * Exit codes: 0 printed; 2 usage error, unsafe value, or no matching directive.md.
 */

import { readdir, readFile, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { exists } from "../../../../lib/fs.ts"
import { pyName } from "./pyname.ts"

const SKILLS_DIR = join(dirname(import.meta.dir), "skills")

/** Sorted mode names — skill folders that ship a `directive.md`. */
export const availableModes = async (skillsDir: string): Promise<string[]> => {
  if (!(await exists(skillsDir)) || !(await stat(skillsDir)).isDirectory()) return []
  const names: string[] = []
  const entries = await readdir(skillsDir)
  for (const entry of entries) {
    const dir = join(skillsDir, entry)
    if (
      (await stat(dir)).isDirectory() &&
      (await exists(join(dir, "directive.md"))) &&
      (await stat(join(dir, "directive.md"))).isFile()
    ) {
      names.push(entry)
    }
  }
  return names.sort()
}

/**
 * The CLI entry: validate <value> against the bare-name guard, then print its
 * directive body verbatim. Returns the process exit code (0 printed; 2 on usage
 * error, an unsafe value, or no matching directive.md) so callers stay testable.
 */
export const main = async (
  argv: string[],
  skillsDir: string = SKILLS_DIR,
  write: (s: string) => void = (s) => process.stdout.write(s),
): Promise<number> => {
  const modes = await availableModes(skillsDir)
  const listing = modes.join(", ") || "none"
  if (argv.length !== 1 || !argv[0] || argv[0].trim() === "") {
    process.stderr.write(`usage: show-mode <value>   (values: ${listing})\n`)
    return 2
  }
  const value = (argv[0] as string).trim()
  if (pyName(value) !== value) {
    process.stderr.write(`unsafe value ${pyRepr(value)}; available: ${listing}\n`)
    return 2
  }
  const body = join(skillsDir, value, "directive.md")
  if (!(await exists(body)) || !(await stat(body)).isFile()) {
    process.stderr.write(`unknown value ${pyRepr(value)}; available: ${listing}\n`)
    return 2
  }
  write(await readFile(body, "utf8"))
  return 0
}

/** Render a string the way Python's `{value!r}` does for the common cases. */
const pyRepr = (value: string): string => {
  if (!value.includes("'") || value.includes('"')) return `'${value}'`
  return `"${value}"`
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)))
}
