/**
 * groovy.ts — shared ideScript bridge: escape a Groovy literal + run a one-shot
 * script. Port of core/_groovy.py.
 *
 * Neutral infra the in-IDE features build on, not tied to any one of them: escape
 * a string for safe embedding in a Groovy double-quoted literal, and run a
 * one-shot Groovy script against the live IntelliJ Platform API. The IDE binary
 * evaluates the script via `ideScript` (its output lands in idea.log); the script
 * reaches Groovy by spilling to a temp `.groovy`, blocking on the run, then
 * handing the temp to the deferred reaper. _preview and notify both layer their
 * templates on this bridge.
 */

import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { IdeaError, NotImplementedError } from "./errors.ts"
import { launch as defaultLaunch, type LaunchOptions } from "./launch.ts"
import { reapLater as defaultReapLater } from "./reap.ts"

/**
 * Escape `literal` for safe embedding inside a Groovy double-quoted string.
 *
 * Backslashes first (so an escaped quote's backslash isn't re-escaped), then
 * double quotes — the same rule the path literals use, hoisted out so the URL
 * and tab-title templates share one escaper.
 */
export const escapeGroovy = (literal: string): string => {
  return literal.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}

/** Seams for hermetic tests; production uses the real launch/reaper/FS. */
export type RunGroovyDeps = {
  launch?: (args: string[], options?: LaunchOptions) => Promise<Bun.Subprocess>
  reapLater?: (paths: Iterable<string>) => void
  /** Spill `groovy` to a temp `.groovy` and return its path. */
  writeTemp?: (groovy: string) => Promise<string>
  /** stderr sink for the swallowed-failure note. Default: process.stderr.write. */
  warn?: (line: string) => void
}

const defaultWriteTemp = async (groovy: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "idea-groovy-"))
  const script = join(dir, `${crypto.randomUUID()}.groovy`)
  await writeFile(script, groovy)
  return script
}

/**
 * The error categories run_groovy swallows: a missing live IDE (IdeaError), an
 * unimplemented platform (NotImplementedError), or an OS error spawning the
 * launcher (a Node system error carries a string `.code` like "ENOENT"). Any
 * other throwable propagates (it's a real bug, not a degrade case).
 */
const isSwallowable = (err: unknown): boolean => {
  if (err instanceof IdeaError || err instanceof NotImplementedError) {
    return true
  }
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string"
}

/**
 * Run a one-shot `groovy` script in the live IDE; never reject.
 *
 * The shared scaffolding behind setPreview/previewUrl: spill `groovy` to a temp
 * `.groovy`, run it via `launch(["ideScript", script], {wait: true})` (block
 * until the IDE has evaluated it), then hand the temp to the deferred reaper
 * rather than racing the IDE's async read (mirrors open_inline).
 *
 * A missing live IDE (IdeaError), an unimplemented platform
 * (NotImplementedError), or an OS error spawning the launcher is swallowed with
 * a `{note}` stderr line — the function never rejects. Callers that have a
 * fallback (setPreview) let the note stand; callers that don't (previewUrl via
 * open_url) treat the note as a hard failure at the CLI boundary.
 */
export const runGroovy = async (groovy: string, note: string, deps: RunGroovyDeps = {}): Promise<void> => {
  const launch = deps.launch ?? defaultLaunch
  const reapLater = deps.reapLater ?? defaultReapLater
  const writeTemp = deps.writeTemp ?? defaultWriteTemp
  const warn = deps.warn ?? ((line: string) => process.stderr.write(line))

  const script = await writeTemp(groovy)
  try {
    try {
      await launch(["ideScript", script], { wait: true })
    } catch (err) {
      if (isSwallowable(err)) {
        const message = err instanceof Error ? err.message : String(err)
        warn(`${note} (${message})\n`)
      } else {
        throw err
      }
    }
  } finally {
    // ideScript forwards to the running IDE async; hand the temp to the
    // deferred reaper rather than racing the read (mirrors open_inline).
    reapLater([script])
  }
}
