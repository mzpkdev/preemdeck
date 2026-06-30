#!/usr/bin/env -S preemdeck-runtime
/**
 * os-alert.ts — raise a desktop banner the moment the host blocks for the user: a
 * tool-permission / access prompt, or an idle wait. Wired on the Notification
 * event — a permission gate is host-driven (not a turn end), so the Stop-hook ding
 * never covers it.
 *
 *     Claude  Notification  matcher ""  message   (the host's notification text)
 *
 * Reads the host's `message` from the hook payload on stdin and pops it as an
 * OS-wide banner via os-notify. The `Notification` event fires when Claude needs
 * permission to use a tool, or when the prompt has sat idle — the body is the
 * host's own message, so it reads correctly either way.
 *
 * Best-effort + SILENT by contract: a missing notifier, absent/foreign stdin, or
 * any error yields a no-op (run() catches internally and exits 0) so the host
 * proceeds unchanged.
 *
 * Claude-only: Codex has no Notification event, and Gemini's is left for a
 * follow-up (its payload shape differs).
 */

import * as path from "node:path"
import { defineCommand, execute } from "cmdore"
import { isNotifyEnabled } from "../../../../common/preemdeck"
import { notify } from "./os-notify"

type HookData = Record<string, unknown>

/**
 * Parse the hook's stdin payload as JSON; {} on anything unexpected. Guards isTTY
 * so a host that leaves stdin attached to the terminal never blocks.
 */
export const readHookInput = async (): Promise<HookData> => {
    try {
        if (process.stdin.isTTY) {
            return {}
        }
        const raw = await Bun.stdin.text()
        const data = raw.trim() ? JSON.parse(raw) : {}
        return data !== null && typeof data === "object" && !Array.isArray(data) ? (data as HookData) : {}
    } catch {
        return {}
    }
}

/**
 * The host's notification text from a `Notification` payload; null when `message`
 * is absent, blank, or not a string. Unlike tool events, a Notification carries
 * its text at the top level, not in `tool_input`.
 */
export const notificationMessage = (data: HookData): string | null => {
    const message = data.message
    return typeof message === "string" && message.trim() ? message.trim() : null
}

/** "<project> · <host>" when a cwd is known, else the bare host label. */
export const alertTitle = (host: string, cwd: string | null | undefined): string => {
    const project = cwd ? path.basename(cwd) : ""
    return project ? `${project} · ${host}` : host
}

/** Derive the banner body (the host's message, or a generic fallback) and title, then pop it. */
const emit = async (host: string): Promise<void> => {
    if (!(await isNotifyEnabled("permission"))) {
        return // user disabled permission alerts via preemdeck.json notify.permission
    }
    const data = await readHookInput()
    const cwd = (data.cwd as string | undefined) || process.env.PWD
    const body = notificationMessage(data) ?? `${host} needs your attention`
    await notify(body, alertTitle(host, cwd))
}

const command = defineCommand({
    name: "os-alert",
    description: "Raise a desktop banner when the host blocks for permission/access or goes idle (Notification).",
    arguments: [{ name: "host", description: "invoking host label (heads the title / fallback body)" }],
    run: async ({ host }) => {
        // Best-effort + SILENT by contract: a notification hook must never error or
        // block the host, so swallow every internal failure and exit 0.
        try {
            await emit(typeof host === "string" && host ? host : "Agent")
        } catch {
            // swallow: a missing notifier, foreign stdin, or notify error must not disrupt the host
        }
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
