#!/usr/bin/env bun
/**
 * turn-notify.ts — turn-end balloon for the running JetBrains IDE, tagged with
 * the firing session.
 *
 * The Stop / AfterAgent hook entrypoint across the three hosts. It derives a
 * per-tab identity so a developer juggling concurrent agent tabs can tell WHICH
 * session yielded:
 *
 *     title:  <project> · <branch>
 *     body:   <one-line gist of the agent's last message>
 *
 * Every host hands the just-finished reply text straight to the hook in its stdin
 * payload (last_assistant_message on Claude/Codex, prompt_response on Gemini), so
 * there is no transcript to parse. <project> is the basename of the payload cwd;
 * <branch> is read live with a short `git rev-parse` in that cwd. The host label
 * (the optional argv[0] positional) heads the title when no cwd is known and is
 * the fallback body.
 *
 * The CLI is a cmdore commandless command: cmdore owns parsing, help, the global
 * flags, and the host positional. The single write reaches through the engine
 * notify() (notify.ts), which bottoms out in its runGroovy effect.fn wrapper. The
 * git-branch READ is injectable via parameter DI (the `deps` seam) for the error
 * branches. Best-effort and SILENT by contract: a missing IDE, absent/foreign
 * stdin, or a git failure yields a graceful fallback (or no balloon), and main()
 * swallows EVERY cmdore/domain failure so a turn-end hook never disrupts the host
 * and ALWAYS exits 0. Dynamic text is HTML-escaped before it reaches the balloon.
 */

import { basename } from "node:path"
import { defineCommand, execute } from "cmdore"
import { spawn } from "../../../../lib/proc.ts"
import { htmlEscape } from "../../../../lib/text.ts"
import { inIdea } from "./core/index.ts"
import { notify } from "./notify.ts"

const PROG = "turn-notify"

/** cmdore metadata for the commandless CLI; version mirrors the idea plugin manifest. */
const METADATA = {
  name: PROG,
  version: "0.1.0",
  description: "Pop a turn-end notification balloon tagged with the firing session.",
} as const

/**
 * Body cap: a couple of wrapped balloon lines. Longer gists truncate on a word
 * boundary with an ellipsis.
 */
export const GIST_MAX = 140

const MD = /[*_`]+/g // inline emphasis / code ticks
const LINK = /\[([^\]]+)\]\([^)]+\)/g // [text](url) -> text
const WS = /\s+/g

type HookData = Record<string, unknown>

/**
 * Parse the hook's stdin payload as JSON; {} on anything unexpected. Guards
 * isTTY so a host that leaves stdin attached to the terminal never blocks.
 */
export const readHookInput = async (): Promise<HookData> => {
  let raw: string
  try {
    if (process.stdin.isTTY) {
      return {}
    }
    raw = await Bun.stdin.text()
  } catch {
    return {}
  }
  try {
    const data = raw.trim() ? JSON.parse(raw) : {}
    return data !== null && typeof data === "object" && !Array.isArray(data) ? (data as HookData) : {}
  } catch {
    return {}
  }
}

/** Drop leading/trailing chars from the set, both ends. */
const stripChars = (s: string, chars: string): string => {
  const set = new Set(chars)
  let start = 0
  let end = s.length
  while (start < end && set.has(s[start] as string)) start += 1
  while (end > start && set.has(s[end - 1] as string)) end -= 1
  return s.slice(start, end)
}

/**
 * First meaningful line of `text`, markdown stripped, truncated to GIST_MAX.
 *
 * Skips leading blockquote (`>`) and heading (`#`) lines, strips inline markdown
 * and link syntax, collapses whitespace, then truncates on a word boundary with
 * an ellipsis.
 */
export const cleanGist = (text: string): string => {
  let line = ""
  for (const raw of text.trim().split("\n")) {
    const candidate = raw.trim()
    if (!candidate || candidate[0] === ">" || candidate[0] === "#") {
      continue
    }
    line = candidate
    break
  }
  if (!line) {
    line = text.trim()
  }
  line = line.replace(LINK, "$1")
  line = line.replace(MD, "")
  line = stripChars(line.replace(WS, " "), " -•\t")
  // Code-point-aware truncation (so multi-byte glyphs aren't split).
  const cps = [...line]
  if (cps.length > GIST_MAX) {
    const head = cps.slice(0, GIST_MAX).join("")
    // Drop the last partial word (whole string if no space).
    const lastSpace = head.lastIndexOf(" ")
    const trimmed = lastSpace === -1 ? head : head.slice(0, lastSpace)
    line = `${trimmed.replace(/\s+$/, "")}…`
  }
  return line
}

/**
 * The current turn's reply text taken straight from the hook payload, cleaned.
 * null for an absent/blank field or Gemini's "[no response text]" sentinel.
 */
export const payloadGist = (data: HookData): string | null => {
  const raw = data.last_assistant_message || data.prompt_response
  if (typeof raw !== "string" || !raw.trim() || raw.trim() === "[no response text]") {
    return null
  }
  return cleanGist(raw) || null
}

/**
 * Current git branch in `cwd` via `git rev-parse --abbrev-ref HEAD`, or null.
 * Best-effort: null with no cwd, outside a repo, in detached HEAD, or on any
 * spawn error/timeout. The short timeout keeps it inside the host's 5s budget.
 */
export const gitBranch = async (cwd: string | null | undefined): Promise<string | null> => {
  if (!cwd) {
    return null
  }
  let result: Awaited<ReturnType<typeof spawn>>
  try {
    result = await spawn(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 2000 })
  } catch {
    return null
  }
  const branch = result.stdout.trim()
  if (result.exitCode !== 0 || !branch || branch === "HEAD") {
    return null
  }
  return branch
}

/**
 * Parameter-DI seam for the value-bearing git-branch READ. The happy path runs
 * the real {@link gitBranch} (driven through a real temp repo in tests); the
 * error branches (detached HEAD, exit 128, git-not-found) inject a stub.
 */
export type TurnNotifyDeps = {
  gitBranch: (cwd: string | null | undefined) => Promise<string | null>
}

/** The default dependency set: the real git-branch read. */
export const DEFAULT_DEPS: TurnNotifyDeps = { gitBranch }

/** `<project> · <branch>` — project from cwd basename, host label as fallback head. */
export const title = (host: string, cwd: string | null | undefined, branch: string | null): string => {
  const project = cwd ? basename(cwd.replace(/\/+$/, "")) : ""
  const head = project || host
  return branch ? `${head} · ${branch}` : head
}

/**
 * Derive the per-tab title + one-line gist and pop the turn-end balloon, reaching
 * through the engine notify(). No-op outside a JetBrains IDE. `deps.gitBranch`
 * supplies the branch READ (real by default, injected in the error-branch tests).
 */
const emit = async (host: string, deps: TurnNotifyDeps): Promise<void> => {
  if (!inIdea()) {
    return // not inside a JetBrains IDE: nothing to pop, and no error
  }
  const data = await readHookInput()
  const cwd = (data.cwd as string | undefined) || process.env.PWD
  const gist = payloadGist(data)
  const branch = await deps.gitBranch(cwd)
  const titleText = title(host, cwd, branch)
  const body = gist || `${host} finished responding`
  await notify(htmlEscape(body), { title: htmlEscape(titleText) })
}

/**
 * The cmdore command behind the hook, built around `deps` so the git-branch READ
 * stays injectable. The optional `host` positional (hosts invoke `turn-notify
 * Gemini`) heads the title when no cwd is known and is the fallback body;
 * defaults to "Agent" when absent.
 */
const buildCommand = (deps: TurnNotifyDeps) =>
  defineCommand({
    name: PROG,
    description: METADATA.description,
    arguments: [{ name: "host", description: "invoking host label (heads the title / fallback body)" }],
    run: async ({ host }) => {
      await emit(typeof host === "string" && host ? host : "Agent", deps)
    },
  })

/**
 * Hook entrypoint: best-effort, SILENT, ALWAYS exits 0. Hands argv to cmdore
 * (parsing, help, the host positional) but swallows EVERY failure (cmdore parse
 * errors and any notify/git failure alike) — a turn-end hook must never error or
 * block the host. `deps` injects the git-branch READ in tests.
 */
export const main = async (
  argv: string[] = Bun.argv.slice(2),
  deps: TurnNotifyDeps = DEFAULT_DEPS,
): Promise<number> => {
  try {
    await execute(buildCommand(deps), { argv, metadata: METADATA, onError: "throw" })
  } catch {
    // best-effort: a turn-end hook must never error or block the host
  }
  return 0
}

if (import.meta.main) {
  process.exit(await main())
}
