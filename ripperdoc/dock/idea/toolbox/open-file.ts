#!/usr/bin/env bun
/**
 * open-file.ts — open a file in the running JetBrains IDE.
 *
 * FIRE-AND-FORGET by default (wait=false): launch() spawns the IDE async and the
 * call resolves null as soon as the process is started. With wait=true,
 * launch({wait:true}) appends the IDE's native --wait and blocks until the tab
 * closes; then reads the file back and returns its full text. launch() is the
 * single guard for a live IDE: it throws IdeaError if none is found.
 *
 * Opt-in preview=true layers a best-effort step AFTER the open: setPreview()
 * flips the editor to the rendered preview via ideScript. setPreview() never
 * throws: a failure degrades with a stderr note, so the open still succeeds.
 *
 * The CLI is a cmdore commandless command: cmdore owns parsing, help, the global
 * flags (--quiet/--verbose/--json/--dry-run/--help/--version), and exit codes.
 * main() wraps execute() with onError:"throw" so it can keep the repo CLI shape
 * (return a number; process.exit only under the import.meta.main guard) and map
 * IdeaError / CmdoreError to the open-file: prefixed stderr line.
 */

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { StandardSchemaV1 } from "cmdore"
import { CmdoreError, defineCommand, effect, execute } from "cmdore"
import { IdeaError } from "./core/errors.ts"
import { inIdea, launch as rawLaunch, setPreview as rawSetPreview } from "./core/index.ts"

const PROG = "open-file"

/** cmdore metadata for the commandless CLI; version mirrors the idea plugin manifest. */
const METADATA = {
  name: PROG,
  version: "0.1.0",
  description: "Open a file in the running JetBrains IDE.",
} as const

/**
 * A Standard Schema that coerces an integer token to a number. cmdore hands it
 * the raw `--line`/`--column` string; a non-integer fails validation, which
 * cmdore surfaces as a CmdoreError carrying this message.
 */
const integer = (flag: string): StandardSchemaV1<number> => ({
  "~standard": {
    version: 1,
    vendor: "preemdeck",
    validate: (value: unknown) => {
      const text = String(value).trim()
      return /^[+-]?\d+$/.test(text)
        ? { value: Number.parseInt(text, 10) }
        : { issues: [{ message: `${flag} must be an integer, got '${value}'` }] }
    },
  },
})

/**
 * The write side-effects, wrapped as cmdore `effect.fn` so they are skipped on
 * `--dry-run` (when cmdore flips `effect.enabled` off) and mockable in tests by
 * the WRAPPER REFERENCE (`effect.mock(launch, …)`) — no per-file mutable seam.
 * The `--wait` read-back is a READ and stays unwrapped (real `node:fs/promises`).
 */
export const launch = effect.fn(rawLaunch, "ide.launch")
export const setPreview = effect.fn(rawSetPreview, "ide.setPreview")

/** Options for {@link openFile}: 1-based caret line/column, the wait toggle, and the rendered-preview opt-in. */
export type OpenFileOptions = {
  line?: number
  column?: number | null
  wait?: boolean
  preview?: boolean
}

/**
 * Open `path` at `line` (and optional `column`) in the running JetBrains IDE.
 * Returns the file's text on the wait path, else null (fire-and-forget).
 */
export const openFile = async (path: string, options: OpenFileOptions = {}): Promise<string | null> => {
  const line = options.line ?? 1
  const column = options.column ?? null
  const wait = options.wait ?? false
  const preview = options.preview ?? false

  const target = resolve(path)
  const args = ["--line", String(line)]
  if (column !== null) {
    args.push("--column", String(column))
  }
  args.push(target)
  await launch(args, { wait })
  if (preview) {
    await setPreview(target)
  }
  return wait ? await readFile(path, { encoding: "utf8" }) : null
}

/**
 * The cmdore command behind the CLI. Gates on a live IDE (cheap fail-fast before
 * launch()'s deeper resolveExecPath() ancestry walk), runs openFile, and on the
 * --wait path writes the file text to stdout verbatim (no trailing newline).
 */
const openFileCommand = defineCommand({
  name: PROG,
  description: METADATA.description,
  arguments: [{ name: "path", description: "file to open", required: true }],
  options: [
    { name: "line", arity: 1, hint: "n", description: "1-based caret line", schema: integer("--line") },
    { name: "column", arity: 1, hint: "n", description: "1-based caret column", schema: integer("--column") },
    { name: "wait", arity: 0, description: "block until the tab closes, then print the file back" },
    { name: "preview", arity: 0, description: "flip the editor to the rendered preview after opening" },
  ],
  run: async ({ path, line, column, wait, preview }) => {
    if (!inIdea()) {
      throw new IdeaError("no JetBrains IDE in the process ancestry")
    }
    const contents = await openFile(path, { line, column, wait, preview })
    if (contents !== null) {
      process.stdout.write(contents)
    }
  },
})

/**
 * CLI entrypoint. Hands argv to cmdore (parsing, help, global flags), then maps
 * the two domain failures to the open-file: stderr line and their exit codes:
 * IdeaError -> 1, CmdoreError (bad flag / missing path / non-integer) -> its
 * own exitCode. Anything else is a bug and rethrown.
 */
export const main = async (argv: string[]): Promise<number> => {
  try {
    await execute(openFileCommand, { argv, metadata: METADATA, onError: "throw" })
  } catch (error) {
    if (error instanceof IdeaError) {
      process.stderr.write(`${PROG}: ${error.message}\n`)
      return 1
    }
    if (error instanceof CmdoreError) {
      process.stderr.write(`${PROG}: ${error.message}\n`)
      return error.exitCode
    }
    throw error
  }
  return 0
}

if (import.meta.main) {
  const code = await main(Bun.argv.slice(2))
  process.exit(code)
}
