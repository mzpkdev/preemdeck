#!/usr/bin/env bun
/**
 * permission-notify.ts — pop a balloon the moment the host blocks for the user:
 * a tool-permission / access prompt, or an idle wait. Neither the Stop hook nor
 * ask-notify covers this — a permission gate is host-driven (not a turn end, not a
 * model-issued AskUserQuestion), so it rides its own event:
 *
 *     Claude  Notification  matcher ""  message   (the host's notification text)
 *
 * The `Notification` event fires when Claude needs permission to use a tool, or
 * when the prompt has sat idle — both are "look at the terminal" moments. The
 * balloon body is the host's own `message`, so it reads correctly either way.
 *
 * Best-effort + SILENT by contract: a missing IDE, absent/foreign stdin, or any
 * notify error yields a no-op (run() catches internally and returns normally) so
 * the host proceeds unchanged. The balloon broadcasts to every window of every
 * product (notify --all), matching the turn-end and ask hooks.
 *
 * Claude-only: Codex has no Notification event, and Gemini's is left for a
 * follow-up (its payload shape differs).
 */

import { defineCommand, execute } from "cmdore"
import { isNotifyEnabled } from "../../../../common/preemdeck"
import { inIdea } from "./core/index"
import { notify } from "./notify"
import { cleanGist, htmlEscape, readHookInput, title } from "./turn-notify"

type HookData = Record<string, unknown>

/**
 * The host's notification text from a `Notification` payload, cleaned to a
 * one-line gist. null when `message` is absent, blank, or not a string — unlike
 * tool events, a Notification carries its text at the top level, not in
 * `tool_input`.
 */
export const notificationMessage = (data: HookData): string | null => {
    const message = data.message
    if (typeof message !== "string" || !message.trim()) {
        return null
    }
    return cleanGist(message) || null
}

/**
 * Derive the balloon body (the host's message, or a generic fallback) and the
 * `<project>·<host>` title, then pop it broadcast to every window. No-op outside
 * a JetBrains IDE.
 */
const emit = async (host: string): Promise<void> => {
    if (!(await isNotifyEnabled("permission"))) {
        return // user disabled permission alerts via preemdeck.json notify.permission
    }
    if (!inIdea()) {
        return // not inside a JetBrains IDE: nothing to pop, and no error
    }
    const data = await readHookInput()
    const cwd = (data.cwd as string | undefined) || process.env.PWD
    const body = notificationMessage(data) ?? `${host} needs your attention`
    const titleText = title(host, cwd, null)
    await notify(htmlEscape(body), { title: htmlEscape(titleText), all: true })
}

const command = defineCommand({
    name: "permission-notify",
    description: "Pop a balloon when the host blocks for permission/access or goes idle (Notification).",
    arguments: [{ name: "host", description: "invoking host label (heads the title / fallback body)" }],
    run: async ({ host }) => {
        // Best-effort + SILENT by contract: a notification hook must never error or
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
