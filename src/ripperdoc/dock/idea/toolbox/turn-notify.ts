#!/usr/bin/env bun
import * as path from "node:path"
import { defineCommand, execute } from "cmdore"
import { isNotifyEnabled } from "../../../../common/preemdeck"
import { PIPED, type Reaped, reap } from "../../../../common/process"
import { inIdea } from "./core/index"
import { notify } from "./notify"

/**
 * Escape `&`, `<`, `>`, `"`, `'` for HTML, quoting `"` and `'` too.
 * `&` is replaced first so the entities it introduces aren't double-escaped.
 *
 *   &  -> &amp;
 *   <  -> &lt;
 *   >  -> &gt;
 *   "  -> &quot;
 *   '  -> &#x27;
 */
export const htmlEscape = (s: string): string =>
    s
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#x27;")

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
    let result: Reaped
    try {
        result = await reap(Bun.spawn(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], PIPED), 2000)
    } catch {
        return null
    }
    const branch = result.stdout.trim()
    if (result.exitCode !== 0 || !branch || branch === "HEAD") {
        return null
    }
    return branch
}

/** `<project> · <branch>` — project from cwd basename, host label as fallback head. */
export const title = (host: string, cwd: string | null | undefined, branch: string | null): string => {
    const project = cwd ? path.basename(cwd.replace(/\/+$/, "")) : ""
    const head = project || host
    return branch ? `${head} · ${branch}` : head
}

/**
 * Pop the turn-end balloon: read the reply gist and reach through the engine
 * notify(), which resolves the title (repo(ticket) · tab) from the hook's cwd.
 * No-op outside a JetBrains IDE.
 */
const emit = async (host: string): Promise<void> => {
    if (!inIdea()) {
        return // not inside a JetBrains IDE: nothing to pop, and no error
    }
    const data = await readHookInput()
    const cwd = (data.cwd as string | undefined) || process.env.PWD
    const gist = payloadGist(data)
    const body = gist || `${host} finished responding`
    // Pass the hook's cwd so notify() resolves the right repo/branch/tab; `all`
    // broadcasts to every open project window so it's visible whichever is focused.
    await notify(htmlEscape(body), { cwd, all: await isNotifyEnabled("broadcast") })
}

const command = defineCommand({
    name: "turn-notify",
    description: "Pop a turn-end notification balloon tagged with the firing session.",
    arguments: [{ name: "host", description: "invoking host label (heads the title / fallback body)" }],
    run: async ({ host }) => {
        // Best-effort + SILENT by contract: a turn-end hook must never error or
        // block the host, so swallow every internal failure and return normally.
        try {
            if (!(await isNotifyEnabled("turn"))) {
                return // user disabled turn-end alerts via preemdeck.json notify.turn
            }
            await emit(typeof host === "string" && host ? host : "Agent")
        } catch {
            // swallow: a missing IDE, foreign stdin, git failure, or notify error
            // must not disrupt the host
        }
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
