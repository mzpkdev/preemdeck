#!/usr/bin/env bun
/**
 * ask-notify.ts — pop a balloon the moment the agent blocks on a structured
 * question, so a tabbed-away user is pinged that an answer is needed. The Stop
 * hook never covers this: AskUserQuestion is a MID-turn tool call, not a turn end.
 *
 *     Claude  PreToolUse  matcher AskUserQuestion  tool_input.questions[].question
 *
 * Fires BEFORE the prompt is answered (PreToolUse) and is best-effort + SILENT by
 * contract: a missing IDE, absent/foreign stdin, or any notify error yields a
 * no-op (run() catches internally and returns normally) so the host's prompt
 * proceeds unchanged. The balloon broadcasts to every window of every product
 * (notify --all), matching the turn-end hook.
 */

import { defineCommand, execute } from "cmdore"
import { isNotifyEnabled } from "../../../../common/preemdeck"
import { inIdea, isTabFocused } from "./core/index"
import { notify } from "./notify"
import { cleanGist, htmlEscape, readHookInput, title } from "./turn-notify"

type HookData = Record<string, unknown>

/**
 * The first question's text from an AskUserQuestion `tool_input`, cleaned to a
 * one-line gist. null when `questions` is absent/empty/malformed or the first
 * entry carries no non-blank `question` string.
 */
export const firstQuestion = (toolInput: HookData): string | null => {
    const questions = toolInput.questions
    if (!Array.isArray(questions) || questions.length === 0) {
        return null
    }
    const first = questions[0]
    if (first === null || typeof first !== "object" || Array.isArray(first)) {
        return null
    }
    const q = (first as Record<string, unknown>).question
    if (typeof q !== "string" || !q.trim()) {
        return null
    }
    return cleanGist(q) || null
}

/**
 * Derive the balloon body (the first question, or a generic fallback) and the
 * `<project>·<host>` title, then pop it broadcast to every window. No-op outside
 * a JetBrains IDE, or when this tab is already focused (the tab glyph flags it).
 */
const emit = async (host: string): Promise<void> => {
    if (!(await isNotifyEnabled("ask"))) {
        return // user disabled question alerts via preemdeck.json notify.ask
    }
    if (!inIdea()) {
        return // not inside a JetBrains IDE: nothing to pop, and no error
    }
    const data = await readHookInput()
    const rawInput = data.tool_input
    const toolInput =
        rawInput !== null && typeof rawInput === "object" && !Array.isArray(rawInput) ? (rawInput as HookData) : {}
    const cwd = (data.cwd as string | undefined) || process.env.PWD
    const body = firstQuestion(toolInput) ?? `${host} needs your answer`
    const titleText = title(host, cwd, null)
    if ((await isTabFocused()).focused) {
        return // this tab is focused: the tab glyph already signals it, so don't also pop a balloon
    }
    await notify(htmlEscape(body), { title: htmlEscape(titleText), all: await isNotifyEnabled("broadcast") })
}

const command = defineCommand({
    name: "ask-notify",
    description: "Pop a balloon when the agent blocks on a structured question (PreToolUse: AskUserQuestion).",
    arguments: [{ name: "host", description: "invoking host label (heads the title / fallback body)" }],
    run: async ({ host }) => {
        // Best-effort + SILENT by contract: a pre-tool hook must never error or
        // block the host, so swallow every internal failure and return normally.
        try {
            await emit(typeof host === "string" && host ? host : "Agent")
        } catch {
            // swallow: a missing IDE, foreign stdin, or notify error must not disrupt the host
        }
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
