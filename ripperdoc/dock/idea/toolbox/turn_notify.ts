#!/usr/bin/env bun
/**
 * turn_notify.ts — turn-end balloon for the running JetBrains IDE, tagged with
 * the firing session. Behavior-identical TS port of turn_notify.py (additive —
 * the .py stays live).
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
 * (argv[0]) heads the title when no cwd is known and is the fallback body.
 *
 * Best-effort and SILENT by contract: a missing IDE, absent/foreign stdin, or a
 * git failure yields a graceful fallback (or no balloon) and ALWAYS exits 0.
 * Dynamic text is HTML-escaped before it reaches the balloon.
 */

import { basename } from "node:path";
import { spawn } from "../../../../lib/proc.ts";
import { htmlEscape } from "../../../../lib/text.ts";
import { inIdea } from "./core/index.ts";
import { notify } from "./notify.ts";

// Body cap: a couple of wrapped balloon lines. Longer gists truncate on a word
// boundary with an ellipsis.
export const GIST_MAX = 140;

const MD = /[*_`]+/g; // inline emphasis / code ticks
const LINK = /\[([^\]]+)\]\([^)]+\)/g; // [text](url) -> text
const WS = /\s+/g;

type HookData = Record<string, unknown>;

// Seam: tests override these instead of mock.module on ./core / ./notify (which
// leaks across the single `bun test` run). Mirrors the Python suite's monkeypatch
// of turn_notify.{in_idea, notify, _git_branch, _read_hook_input}. `spawn` is the
// _git_branch unit seam (the Python suite monkeypatched subprocess.run).
export const _internals = { inIdea, notify, gitBranch, readHookInput, spawn };

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

/** Python str.strip(chars): drop leading/trailing chars from the set, both ends. */
function stripChars(s: string, chars: string): string {
  const set = new Set(chars);
  let start = 0;
  let end = s.length;
  while (start < end && set.has(s[start] as string)) start += 1;
  while (end > start && set.has(s[end - 1] as string)) end -= 1;
  return s.slice(start, end);
}

/**
 * First meaningful line of `text`, markdown stripped, truncated to GIST_MAX.
 *
 * Skips leading blockquote (`>`) and heading (`#`) lines, strips inline markdown
 * and link syntax, collapses whitespace, then truncates on a word boundary with
 * an ellipsis. Byte-for-byte parity with turn_notify.py _clean_gist.
 */
export function cleanGist(text: string): string {
  let line = "";
  for (const raw of text.trim().split("\n")) {
    const candidate = raw.trim();
    if (!candidate || candidate[0] === ">" || candidate[0] === "#") {
      continue;
    }
    line = candidate;
    break;
  }
  if (!line) {
    line = text.trim();
  }
  line = line.replace(LINK, "$1");
  line = line.replace(MD, "");
  line = stripChars(line.replace(WS, " "), " -•\t");
  // Code-point-aware to match Python's len()/slicing (str is code points).
  const cps = [...line];
  if (cps.length > GIST_MAX) {
    const head = cps.slice(0, GIST_MAX).join("");
    // Python's rsplit(" ", 1)[0]: drop the last partial word (whole string if no space).
    const lastSpace = head.lastIndexOf(" ");
    const trimmed = lastSpace === -1 ? head : head.slice(0, lastSpace);
    line = `${trimmed.replace(/\s+$/, "")}…`;
  }
  return line;
}

/**
 * The current turn's reply text taken straight from the hook payload, cleaned.
 * None for an absent/blank field or Gemini's "[no response text]" sentinel.
 */
export function payloadGist(data: HookData): string | null {
  const raw = data.last_assistant_message || data.prompt_response;
  if (typeof raw !== "string" || !raw.trim() || raw.trim() === "[no response text]") {
    return null;
  }
  return cleanGist(raw) || null;
}

/**
 * Current git branch in `cwd` via `git rev-parse --abbrev-ref HEAD`, or null.
 * Best-effort: null with no cwd, outside a repo, in detached HEAD, or on any
 * spawn error/timeout. The short timeout keeps it inside the host's 5s budget.
 */
export async function gitBranch(cwd: string | null | undefined): Promise<string | null> {
  if (!cwd) {
    return null;
  }
  let result: Awaited<ReturnType<typeof spawn>>;
  try {
    result = await _internals.spawn(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 2000 });
  } catch {
    return null;
  }
  const branch = result.stdout.trim();
  if (result.exitCode !== 0 || !branch || branch === "HEAD") {
    return null;
  }
  return branch;
}

/** `<project> · <branch>` — project from cwd basename, host label as fallback head. */
export function title(host: string, cwd: string | null | undefined, branch: string | null): string {
  const project = cwd ? basename(cwd.replace(/\/+$/, "")) : "";
  const head = project || host;
  return branch ? `${head} · ${branch}` : head;
}

export async function main(argv: string[] = Bun.argv.slice(2)): Promise<number> {
  // argv[0] is the host label (e.g. "Claude").
  const host = argv.length > 0 ? (argv[0] as string) : "Agent";
  try {
    if (!_internals.inIdea()) {
      return 0; // not inside a JetBrains IDE: nothing to pop, and no error
    }
    const data = await _internals.readHookInput();
    const cwd = (data.cwd as string | undefined) || process.env.PWD;
    const gist = payloadGist(data);
    const branch = await _internals.gitBranch(cwd);
    const titleText = title(host, cwd, branch);
    const body = gist || `${host} finished responding`;
    await _internals.notify(htmlEscape(body), { title: htmlEscape(titleText) });
  } catch {
    // best-effort: a turn-end hook must never error or block the host
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
