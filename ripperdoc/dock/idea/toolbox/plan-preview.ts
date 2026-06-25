#!/usr/bin/env bun
/**
 * plan-preview.ts — open an agent's freshly-presented plan in the IDE's rendered
 * markdown preview.
 *
 * The plan-presentation hook entrypoint, shared by two hosts that fire a pre-tool
 * event the moment the agent exits plan mode:
 *
 *     Claude  PreToolUse  matcher ExitPlanMode    tool_input.plan       (markdown string)
 *     Gemini  BeforeTool  matcher exit_plan_mode  tool_input.plan_path  (markdown file)
 *
 * Both fire BEFORE the host's approval gate. The script branches on which field
 * the payload carries: Claude's inline plan -> openInline (spilled to a .md
 * temp); Gemini's path -> openFile directly. Both opens are fire-and-forget +
 * preview.
 *
 * Best-effort and SILENT by contract: a missing IDE, absent or foreign stdin, or
 * any open failure yields a no-op and ALWAYS exits 0 with empty stdout (so the
 * host proceeds to its normal approval gate unchanged). The CLI is a cmdore
 * commandless command, but main() swallows every cmdore/domain failure to keep
 * that never-disrupt-the-host contract — the reach-through to the IDE bottoms out
 * in open-file's launch/setPreview wrappers (openInline -> openFile -> launch).
 * It accepts an optional host-name positional (e.g. `plan-preview Gemini`) that
 * cmdore binds but the dispatch ignores: the field present in stdin decides.
 */

import { defineCommand, execute } from "cmdore"
import { inIdea } from "./core/index.ts"
import { open } from "./open-file.ts"
import { openInline } from "./open-inline.ts"

const PROG = "plan-preview"

/** cmdore metadata for the commandless CLI; version mirrors the idea plugin manifest. */
const METADATA = {
  name: PROG,
  version: "0.1.0",
  description: "Open an agent's freshly-presented plan in the IDE's rendered markdown preview.",
} as const

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
    await open(planPath, { preview: true })
    return
  }
  const plan = toolInput.plan
  if (typeof plan === "string" && plan.trim()) {
    await openInline(plan, { suffix: ".md", preview: true })
  }
}

/**
 * The cmdore command behind the hook. No-op outside a JetBrains IDE; otherwise
 * reads the hook payload from stdin and routes its plan to the rendered preview.
 * The optional `host` positional is accepted (hosts may invoke `plan-preview
 * Gemini`) but unused — the stdin field present is what selects the path.
 */
const planPreviewCommand = defineCommand({
  name: PROG,
  description: METADATA.description,
  arguments: [{ name: "host", description: "invoking host name (ignored; the stdin field selects the path)" }],
  run: async () => {
    if (!inIdea()) {
      return // not inside a JetBrains IDE: nothing to open, and no error
    }
    const data = await readHookInput()
    const toolInput = data.tool_input
    if (toolInput !== null && typeof toolInput === "object" && !Array.isArray(toolInput)) {
      await openPlan(toolInput as HookData)
    }
  },
})

/**
 * Hook entrypoint: best-effort, SILENT, ALWAYS exits 0. Hands argv to cmdore but
 * swallows EVERY failure (cmdore parse errors and any open failure alike) — a
 * pre-tool hook must never error or block the host.
 */
export const main = async (argv: string[] = Bun.argv.slice(2)): Promise<number> => {
  try {
    await execute(planPreviewCommand, { argv, metadata: METADATA, onError: "throw" })
  } catch {
    // best-effort: a pre-tool hook must never error or block the host
  }
  return 0
}

if (import.meta.main) {
  process.exit(await main())
}
