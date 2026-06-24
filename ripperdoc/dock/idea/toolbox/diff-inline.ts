#!/usr/bin/env bun
/**
 * diff-inline.ts — diff two inline strings in the running JetBrains IDE.
 *
 * A string-native wrapper over diffFile: each version is spilled to a temp file
 * — `target` -> left, `suggestion` -> right — and handed to diffFile in
 * positional order. wait=true: diffFile blocks and returns the LEFT pane's text;
 * unlink both temps. wait=false: diffFile launched async; schedule a deferred
 * reap for both temps and return null.
 *
 * This is a COMPOSITE CLI: diffInline does not spawn the IDE itself — it
 * delegates to diff-file's diffFile, which owns the launch (its `launch` wrapper
 * is the leaf write). diffInline's own effects (writeTemp, reapLater) stay real.
 *
 * The CLI is a cmdore commandless command: cmdore owns parsing, help, the global
 * flags (--quiet/--verbose/--json/--dry-run/--help/--version), and exit codes.
 * main() wraps execute() with onError:"throw" so it can keep the repo CLI shape
 * (return a number; process.exit only under the import.meta.main guard) and map
 * IdeaError / a strict-resolve ENOENT / CmdoreError to the diff-inline: stderr line.
 */

import { unlink } from "node:fs/promises"
import { CmdoreError, defineCommand, execute } from "cmdore"
import { IdeaError } from "./core/errors.ts"
import { inIdea, reapLater } from "./core/index.ts"
import { diffFile } from "./diff-file.ts"
import { writeTemp } from "./tmp.ts"

const PROG = "diff-inline"

/** cmdore metadata for the commandless CLI; version mirrors the idea plugin manifest. */
const METADATA = {
  name: PROG,
  version: "0.1.0",
  description: "Diff two inline strings in the running JetBrains IDE.",
} as const

/** Options for {@link diffInline}: the temp-file suffix (drives IDE syntax highlighting) and the wait toggle. */
export type DiffInlineOptions = {
  suffix?: string
  wait?: boolean
}

/** Diff inline strings by spilling each to a temp file, then delegating to diffFile. */
export const diffInline = async (
  target: string,
  suggestion: string,
  options: DiffInlineOptions = {},
): Promise<string | null> => {
  const suffix = options.suffix ?? ".txt"
  const wait = options.wait ?? false
  const temps: string[] = []
  try {
    const targetTmp = await writeTemp(target, suffix)
    temps.push(targetTmp)
    const suggestionTmp = await writeTemp(suggestion, suffix)
    temps.push(suggestionTmp)
    const contents = await diffFile(targetTmp, suggestionTmp, wait)
    if (!wait) {
      // Fire-and-forget: the IDE still has both temps open; defer the reap.
      reapLater([targetTmp, suggestionTmp])
    }
    return contents
  } finally {
    // wait=true: diffFile already returned, temps are spent — remove now.
    if (wait) {
      for (const path of temps) {
        await unlink(path)
      }
    }
  }
}

/**
 * The cmdore command behind the CLI. Gates on a live IDE (cheap fail-fast before
 * diffInline spills temps and delegates to diffFile), runs diffInline, and on the
 * --wait path writes the LEFT pane's text to stdout verbatim.
 */
const diffInlineCommand = defineCommand({
  name: PROG,
  description: METADATA.description,
  arguments: [
    { name: "target", description: "LEFT pane string", required: true },
    { name: "suggestion", description: "RIGHT pane string", required: true },
  ],
  options: [
    { name: "suffix", arity: 1, hint: "ext", description: "temp-file suffix (drives IDE syntax highlighting)" },
    { name: "wait", arity: 0, description: "block until the tab closes, then print the LEFT pane back" },
  ],
  run: async ({ target, suggestion, suffix, wait }) => {
    // Cheap CLI gate: fail fast/clean outside a JetBrains terminal.
    if (!inIdea()) {
      throw new IdeaError("no JetBrains IDE in the process ancestry")
    }
    const contents = await diffInline(target, suggestion, { suffix, wait })
    if (contents !== null) {
      process.stdout.write(contents)
    }
  },
})

/**
 * CLI entrypoint. Hands argv to cmdore (parsing, help, global flags), then maps
 * the domain failures to the diff-inline: stderr line and their exit codes:
 * IdeaError -> 1, a strict-resolve ENOENT (Error with a string `.code`) -> 1,
 * CmdoreError (missing/unknown arg) -> its own exitCode. Else rethrow.
 */
export const main = async (argv: string[] = Bun.argv.slice(2)): Promise<number> => {
  try {
    await execute(diffInlineCommand, { argv, metadata: METADATA, onError: "throw" })
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
