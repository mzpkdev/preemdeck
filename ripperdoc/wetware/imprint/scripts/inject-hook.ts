#!/usr/bin/env -S preemdeck-bun
/**
 * inject-hook.ts — imprint-template context injector.
 *
 * Resolves a template (positional path, or `--file <name>` -> <NAME>.md), reads it
 * from the plugin root, substitutes the optional host-tools file's contents for
 * `{{host_tools}}`, strips, and injects via lib/hook.ts. Missing/empty files are a
 * silent `{}` no-op; a missing host-tools file substitutes empty. Default event
 * UserPromptSubmit; `--event <name>` (first only) is the fallback; stdin wins.
 *
 * Path note: args resolve as `PLUGIN_ROOT / arg` with an "absolute arg wins"
 * rule — Node's `resolve()` honors absolute temp paths verbatim. PLUGIN_ROOT =
 * <script-dir>/.. (scripts/ -> imprint/).
 */

import { readFile, stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { exists } from "../../../../lib/fs.ts"
import { runInjectionHook } from "../../../../lib/inject.ts"

const PLUGIN_ROOT = dirname(import.meta.dir)
// (The UserPromptSubmit default lives in lib/inject.ts; the --event flag overrides it.)

/**
 * Pull `--event <name>` out of argv; return [event_or_null, remaining_argv].
 * Only the first `--event` is honored.
 */
export const extractEventArg = (argv: string[]): [string | null, string[]] => {
  const out: string[] = []
  let event: string | null = null
  let i = 0
  while (i < argv.length) {
    if (argv[i] === "--event" && event === null) {
      if (i + 1 < argv.length) {
        event = argv[i + 1] as string
        i += 2
        continue
      }
      i += 1
      continue
    }
    out.push(argv[i] as string)
    i += 1
  }
  return [event, out]
}

/**
 * Resolve argv[0] into a template path; return [path_or_null, remaining_argv].
 *   --file <name>  -> <NAME>.md (uppercased)
 *   <path>         -> used verbatim
 */
export const resolveTemplateArg = (argv: string[]): [string | null, string[]] => {
  if (argv.length === 0) return [null, []]
  if (argv[0] === "--file") {
    if (argv.length < 2) return [null, []]
    return [`${(argv[1] as string).toUpperCase()}.md`, argv.slice(2)]
  }
  return [argv[0] as string, argv.slice(1)]
}

const isFile = async (path: string): Promise<boolean> => {
  return (await exists(path)) && (await stat(path)).isFile()
}

/**
 * Build the injected text from argv (the script's tail). Returns the stripped
 * text, or null for any no-op (no template arg, missing/empty template, empty
 * after substitution+strip). `pluginRoot` defaults to the real plugin root.
 */
export const renderTemplate = async (argv: string[], pluginRoot: string = PLUGIN_ROOT): Promise<string | null> => {
  const [templateRel, rest] = resolveTemplateArg(argv)
  if (templateRel === null) return null

  const promptPath = resolve(pluginRoot, templateRel)
  if (!(await isFile(promptPath))) return null
  const template = await readFile(promptPath, "utf8")

  let hostTools = ""
  if (rest.length > 0) {
    const hostPath = resolve(pluginRoot, rest[0] as string)
    if (await isFile(hostPath)) {
      hostTools = (await readFile(hostPath, "utf8")).trim()
    }
  }

  const text = template.replaceAll("{{host_tools}}", hostTools).trim()
  return text || null
}

if (import.meta.main) {
  const [cliEvent, argv] = extractEventArg(Bun.argv.slice(2))
  const text = await renderTemplate(argv)
  await runInjectionHook({
    event: cliEvent ?? undefined,
    render: () => text,
  })
  process.exit(0)
}
