#!/usr/bin/env bun
/**
 * plan-preview.ts — open an agent's freshly-presented plan in the IDE's rendered
 * markdown preview. The plan-presentation hook entrypoint, fired by two hosts the
 * moment the agent exits plan mode:
 *
 *     Claude  PreToolUse  matcher ExitPlanMode    tool_input.plan       (markdown string)
 *     Gemini  BeforeTool  matcher exit_plan_mode  tool_input.plan_path  (markdown file)
 *
 * Both fire BEFORE the host's approval gate. run() branches on which field the
 * payload carries: Claude's inline plan -> openInline (.md temp); Gemini's path
 * -> open directly. Both opens are fire-and-forget + preview.
 *
 * Best-effort and SILENT by contract: a missing IDE, absent/foreign stdin, or any
 * open failure yields a no-op (run() catches internally and returns normally) so
 * the host proceeds to its approval gate unchanged.
 */

import { defineCommand, execute } from "cmdore"
import { isNotifyEnabled } from "../../../../common/preemdeck"
import { inIdea } from "./core"
import { openFile } from "./open-file"
import { openInline } from "./open-inline"

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

/**
 * Dispatch the plan to the IDE's rendered preview by which field is present.
 * `plan_path` (Gemini's file) is checked first and opened directly; otherwise
 * `plan` (Claude's inline string) is spilled to a .md temp and opened. The two
 * are host-exclusive, so the order is just defensive.
 */
const openPlan = async (toolInput: HookData): Promise<void> => {
    const planPath = toolInput.plan_path
    if (typeof planPath === "string" && planPath.trim()) {
        await openFile(planPath, { preview: true })
        return
    }
    const plan = toolInput.plan
    if (typeof plan === "string" && plan.trim()) {
        await openInline(plan, { suffix: ".md", preview: true })
    }
}

const command = defineCommand({
    name: "plan-preview",
    description: "Open an agent's freshly-presented plan in the IDE's rendered markdown preview.",
    arguments: [{ name: "host", description: "invoking host name (ignored; the stdin field selects the path)" }],
    run: async () => {
        // Best-effort: a pre-tool hook must never error or block the host, so any
        // failure inside the dispatch is swallowed and run() returns normally.
        try {
            if (!(await isNotifyEnabled("plan"))) {
                return // user disabled plan previews via preemdeck.json notify.plan
            }
            if (!inIdea()) {
                return // not inside a JetBrains IDE: nothing to open, and no error
            }
            const data = await readHookInput()
            const toolInput = data.tool_input
            if (toolInput !== null && typeof toolInput === "object" && !Array.isArray(toolInput)) {
                await openPlan(toolInput as HookData)
            }
        } catch {
            // swallow: never disrupt the host
        }
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
