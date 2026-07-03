#!/usr/bin/env bun
/**
 * permission-notify.ts — pop a balloon the moment the host blocks for the user on
 * a tool-permission / access prompt. Neither the Stop hook nor ask-notify covers
 * this — a permission gate is host-driven (not a turn end, not a model-issued
 * AskUserQuestion), so it rides its own event:
 *
 *     Claude  Notification  matcher ""  message   (the host's notification text)
 *
 * The `Notification` event ALSO fires the idle "waiting for your input" ping after
 * ~60s of no input; that isn't an action item, so isIdleNotification filters it
 * out and only permission/access prompts pop. The balloon body is the host's own
 * `message`.
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
import { inIdea, isTabFocused } from "./core/index"
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
 * Whether the payload is the idle "Claude is waiting for your input" ping the
 * Notification event fires after ~60s of no input — NOT a permission/access
 * prompt. Filtered so the balloon only pops when there's something to act on.
 */
export const isIdleNotification = (data: HookData): boolean => {
    const message = data.message
    return typeof message === "string" && /waiting for your input/i.test(message)
}

/**
 * Derive the balloon body (the host's message, or a generic fallback) and the
 * `<project>·<host>` title, then pop it broadcast to every window. No-op outside
 * a JetBrains IDE, or when this tab is already focused (the tab glyph flags it).
 */
const emit = async (host: string): Promise<void> => {
    if (!(await isNotifyEnabled("permission"))) {
        return // user disabled permission alerts via preemdeck.json notify.permission
    }
    if (!inIdea()) {
        return // not inside a JetBrains IDE: nothing to pop, and no error
    }
    const data = await readHookInput()
    if (isIdleNotification(data)) {
        return // the idle "waiting for your input" ping, not a permission/access prompt
    }
    const cwd = (data.cwd as string | undefined) || process.env.PWD
    const body = notificationMessage(data) ?? `${host} needs your attention`
    const titleText = title(host, cwd, null)
    if ((await isTabFocused()).focused) {
        return // this tab is focused: the tab glyph already signals it, so don't also pop a balloon
    }
    await notify(htmlEscape(body), { title: htmlEscape(titleText), all: await isNotifyEnabled("broadcast") })
}

const command = defineCommand({
    name: "permission-notify",
    description: "Pop a balloon when the host blocks for permission/access (Notification; idle pings filtered).",
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
