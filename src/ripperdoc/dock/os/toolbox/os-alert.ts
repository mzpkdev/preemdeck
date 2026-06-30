#!/usr/bin/env -S preemdeck-runtime
/**
 * os-alert.ts — raise a desktop banner the moment the host blocks for the user on
 * a tool-permission / access prompt. Wired on the Notification event — a
 * permission gate is host-driven (not a turn end), so the Stop-hook ding never
 * covers it.
 *
 *     Claude  Notification  matcher ""  message  (the host's notification text)
 *     Gemini  Notification  matcher ""  message  (same top-level field name)
 *
 * Reads the host's `message` from the hook payload on stdin and pops it as an
 * OS-wide banner via os-notify. On Claude the `Notification` event ALSO fires the
 * idle "waiting for your input" ping after ~60s of no input; that isn't an action
 * item, so isIdleNotification filters it out and only permission/access prompts pop.
 *
 * Host coverage — keyed off the per-host availability of a Notification event
 * (see llm-docs/CLAUDE_CODEX_GEMINI.md "Hook events"):
 *   - Claude: native `Notification` (payload: `message`, `notification_type`, opt
 *     `title`); `notification_type` spans both permission AND idle prompts.
 *   - Gemini: native `Notification`, SAME top-level `message` field (snake_case,
 *     alongside `notification_type`/`details`). Its only notification_type is
 *     `ToolPermission` — there is NO idle/"waiting for input" variant (the proposed
 *     ShellInteraction type was closed not-planned, google-gemini/gemini-cli#19527),
 *     so the idle filter below is simply inert on Gemini, never a false skip.
 *   - Codex: NO Notification event exists, so permission/idle desktop alerts are
 *     UNSUPPORTED on Codex — this hook is simply not wired in the .codex-plugin
 *     manifest. (Firing it on Stop would conflate a turn end with a permission
 *     gate and double up with the os-ding Stop hook, so we deliberately skip it.)
 *
 * Best-effort + SILENT by contract: a missing notifier, absent/foreign stdin, or
 * any error yields a no-op (run() catches internally and exits 0) so the host
 * proceeds unchanged.
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
 * is absent, blank, or not a string. Unlike tool events, a Notification carries its
 * text at the top level (not in `tool_input`); Claude and Gemini both name it
 * `message`, so a single read covers both.
 */
export const notificationMessage = (data: HookData): string | null => {
    const message = data.message
    return typeof message === "string" && message.trim() ? message.trim() : null
}

/**
 * Whether the payload is the idle "waiting for your input" ping Claude's
 * Notification event fires after ~60s of no input — NOT a permission/access prompt.
 * Filtered so the banner only pops when there's something to act on. (Gemini has no
 * idle notification_type, so this is inert there — see the header.)
 */
export const isIdleNotification = (data: HookData): boolean => {
    const message = data.message
    return typeof message === "string" && /waiting for your input/i.test(message)
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
    if (isIdleNotification(data)) {
        return // the idle "waiting for your input" ping, not a permission/access prompt
    }
    const cwd = (data.cwd as string | undefined) || process.env.PWD
    const body = notificationMessage(data) ?? `${host} needs your attention`
    await notify(body, alertTitle(host, cwd))
}

const command = defineCommand({
    name: "os-alert",
    description:
        "Raise a desktop banner when the host blocks for permission/access (Notification; idle pings filtered).",
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
