#!/usr/bin/env bun
/**
 * plan_preview.ts — open an agent's freshly-presented plan in the IDE's rendered
 * markdown preview. Behavior-identical TS port of plan_preview.py (additive — the
 * .py stays live).
 *
 * The plan-presentation hook entrypoint, shared by two hosts that fire a pre-tool
 * event the moment the agent exits plan mode:
 *
 *     Claude  PreToolUse  matcher ExitPlanMode    tool_input.plan       (markdown string)
 *     Gemini  BeforeTool  matcher exit_plan_mode  tool_input.plan_path  (markdown file)
 *
 * Both fire BEFORE the host's approval gate. The script branches on which field
 * the payload carries: Claude's inline plan -> open_inline (spilled to a .md
 * temp); Gemini's path -> open_file directly. Both opens are fire-and-forget +
 * preview.
 *
 * Best-effort and SILENT by contract, like turn_notify: a missing IDE, absent or
 * foreign stdin, or any open failure yields a no-op and ALWAYS exits 0 with empty
 * stdout (so the host proceeds to its normal approval gate unchanged).
 */

import { inIdea } from "./core/index.ts";
import { openFile } from "./open_file.ts";
import { openInline } from "./open_inline.ts";

type HookData = Record<string, unknown>;

// Seam: tests override these instead of mock.module on ./core / the openers
// (which leaks across the single `bun test` run). Mirrors the Python suite's
// monkeypatch of plan_preview.{in_idea, open_file, open_inline, _read_hook_input}.
export const _internals = { inIdea, openFile, openInline, readHookInput };

/**
 * Parse the hook's stdin payload as JSON; {} on anything unexpected. Guards
 * isTTY so a host that leaves stdin attached to the terminal never blocks.
 */
export async function readHookInput(): Promise<HookData> {
  let raw: string;
  try {
    if (process.stdin.isTTY) {
      return {};
    }
    raw = await Bun.stdin.text();
  } catch {
    return {};
  }
  try {
    const data = raw.trim() ? JSON.parse(raw) : {};
    return data !== null && typeof data === "object" && !Array.isArray(data) ? (data as HookData) : {};
  } catch {
    return {};
  }
}

/**
 * Dispatch the plan to the IDE's rendered preview by which field is present.
 * `plan_path` (Gemini's file) is checked first and opened directly; otherwise
 * `plan` (Claude's inline string) is spilled to a .md temp and opened. The two
 * are host-exclusive, so the order is just defensive.
 */
async function openPlan(toolInput: HookData): Promise<void> {
  const planPath = toolInput["plan_path"];
  if (typeof planPath === "string" && planPath.trim()) {
    await _internals.openFile(planPath, { preview: true });
    return;
  }
  const plan = toolInput["plan"];
  if (typeof plan === "string" && plan.trim()) {
    await _internals.openInline(plan, { suffix: ".md", preview: true });
  }
}

export async function main(): Promise<number> {
  try {
    if (!_internals.inIdea()) {
      return 0; // not inside a JetBrains IDE: nothing to open, and no error
    }
    const data = await _internals.readHookInput();
    const toolInput = data["tool_input"];
    if (toolInput !== null && typeof toolInput === "object" && !Array.isArray(toolInput)) {
      await openPlan(toolInput as HookData);
    }
  } catch {
    // best-effort: a pre-tool hook must never error or block the host
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
