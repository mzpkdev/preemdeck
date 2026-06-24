#!/usr/bin/env bun
/**
 * diff-file.ts — diff two files in the running JetBrains IDE.
 *
 * The positionals map straight onto `idea diff`'s panes: `diff L R` (passthrough)
 * — `target` LEFT, `suggestion` RIGHT. Both inputs are resolved strictly, so a
 * missing path throws before anything launches. FIRE-AND-FORGET by default;
 * wait=true blocks on the IDE's native --wait, then reads back the LEFT pane.
 *
 * The CLI is a cmdore commandless command: cmdore owns parsing, help, the global
 * flags (--quiet/--verbose/--json/--dry-run/--help/--version), and exit codes.
 * main() wraps execute() with onError:"throw" so it can keep the repo CLI shape
 * (return a number; process.exit only under the import.meta.main guard) and map
 * IdeaError / a strict-resolve ENOENT / CmdoreError to the diff-file: stderr line.
 */

import { readFile } from "node:fs/promises"
import { CmdoreError, defineCommand, effect, execute } from "cmdore"
import { IdeaError } from "./core/errors.ts"
import { inIdea, launch as rawLaunch } from "./core/index.ts"
import { resolveStrict } from "./tmp.ts"

const PROG = "diff-file"

/** cmdore metadata for the commandless CLI; version mirrors the idea plugin manifest. */
const METADATA = {
  name: PROG,
  version: "0.1.0",
  description: "Diff two files in the running JetBrains IDE.",
} as const

/**
 * The write side-effect, wrapped as cmdore `effect.fn` so it is skipped on
 * `--dry-run` (when cmdore flips `effect.enabled` off) and mockable in tests by
 * the WRAPPER REFERENCE (`effect.mock(launch, …)`) — no per-file mutable seam.
 * The `--wait` read-back is a READ and stays unwrapped (real `node:fs/promises`).
 */
export const launch = effect.fn(rawLaunch, "ide.launch")

/**
 * Open a 2-way (`target` vs `suggestion`) diff in the running JetBrains IDE.
 * Returns the LEFT (`target`) pane's text on the wait path, else null.
 */
export const diffFile = async (target: string, suggestion: string, wait = false): Promise<string | null> => {
  const targetAbs = await resolveStrict(target)
  const suggestionAbs = await resolveStrict(suggestion)
  const args = ["diff", targetAbs, suggestionAbs]
  // 2-way always watches `target` (LEFT). launch() owns the native --wait.
  await launch(args, { wait })
  return wait ? await readFile(targetAbs, { encoding: "utf8" }) : null
}

/**
 * The cmdore command behind the CLI. Gates on a live IDE, runs diffFile, and on
 * the --wait path writes the LEFT pane's text to stdout verbatim.
 */
const diffFileCommand = defineCommand({
  name: PROG,
  description: METADATA.description,
  arguments: [
    { name: "target", description: "LEFT pane file", required: true },
    { name: "suggestion", description: "RIGHT pane file", required: true },
  ],
  options: [{ name: "wait", arity: 0, description: "block until the tab closes, then print the LEFT pane back" }],
  run: async ({ target, suggestion, wait }) => {
    // Cheap CLI gate: fail fast/clean outside a JetBrains terminal.
    if (!inIdea()) {
      throw new IdeaError("no JetBrains IDE in the process ancestry")
    }
    const contents = await diffFile(target, suggestion, wait)
    if (contents !== null) {
      process.stdout.write(contents)
    }
  },
})

/**
 * CLI entrypoint. Hands argv to cmdore (parsing, help, global flags), then maps
 * the domain failures to the diff-file: stderr line and their exit codes:
 * IdeaError -> 1, a strict-resolve ENOENT (Error with a string `.code`) -> 1,
 * CmdoreError (missing/unknown arg) -> its own exitCode. Else rethrow.
 */
export const main = async (argv: string[] = Bun.argv.slice(2)): Promise<number> => {
  try {
    await execute(diffFileCommand, { argv, metadata: METADATA, onError: "throw" })
  } catch (error) {
    if (error instanceof CmdoreError) {
      process.stderr.write(`${PROG}: ${error.message}\n`)
      return error.exitCode
    }
    if (
      error instanceof IdeaError ||
      (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string")
    ) {
      process.stderr.write(`${PROG}: ${error.message}\n`)
      return 1
    }
    throw error
  }
  return 0
}

if (import.meta.main) {
  process.exit(await main())
}
