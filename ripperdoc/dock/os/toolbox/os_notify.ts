#!/usr/bin/env -S preemdeck-bun
/**
 * os_notify.ts — raise an OS-wide desktop notification (port of os_notify.py).
 *
 * macOS + Linux only. macOS prefers `terminal-notifier` (its own bundle = delivery
 * independent of the launching app's permissions), else osascript `display
 * notification`. Linux uses `notify-send`.
 *
 * SECURITY (preserved verbatim): user text is NEVER spliced into a script. The
 * osascript path reads title/body from environment variables (`system attribute`);
 * notify-send and terminal-notifier take them as argv. So quotes/backslashes/
 * newlines in the title/body can't break out into code — there's no script string
 * to break out of. The env vars are passed out-of-band via lib/proc.ts (merged
 * over process.env), never interpolated into the command line.
 *
 * Best-effort: returns the mechanism that fired, or null; the CLI surfaces null as
 * exit 1 (echoing the text to stderr) — there is NO universal floor for a banner.
 */

import { parseArgs } from "node:util";
import { usageError } from "../../../../lib/args.ts";
import { spawn } from "../../../../lib/proc.ts";

const DEFAULT_TITLE = "PreemDeck";

// User text rides these env vars on macOS (out-of-band), never the script source.
const ENV_TITLE = "PD_NOTIFY_TITLE";
const ENV_MESSAGE = "PD_NOTIFY_MESSAGE";

// A static AppleScript that reads title/body from the environment; only our own
// constant env-var NAMES are spliced — never any user text.
export const MACOS_APPLESCRIPT = `display notification (system attribute "${ENV_MESSAGE}") with title (system attribute "${ENV_TITLE}")`;

/**
 * Run `cmd` to completion; resolve true iff it spawned and exited 0. `env` (if
 * given) is merged OVER the current environment (so PATH/DISPLAY survive and the
 * notification vars are added). A missing binary, non-zero exit, or timeout all
 * resolve false. Never throws.
 */
export async function runCmd(cmd: string[], env?: Record<string, string>): Promise<boolean> {
  try {
    const result = await spawn(cmd, { timeoutMs: 20_000, env });
    return !result.timedOut && result.exitCode === 0;
  } catch {
    return false;
  }
}

/** Whether an executable is on PATH — the Bun analogue of shutil.which. */
function which(name: string): boolean {
  return Bun.which(name) !== null;
}

/** macOS: terminal-notifier if installed (and it fires), else osascript. */
export async function notifyMacos(
  message: string,
  title: string,
  deps: {
    run?: (cmd: string[], env?: Record<string, string>) => Promise<boolean>;
    has?: (name: string) => boolean;
  } = {},
): Promise<string | null> {
  const run = deps.run ?? runCmd;
  const has = deps.has ?? which;
  if (has("terminal-notifier") && (await run(["terminal-notifier", "-title", title, "-message", message]))) {
    return "terminal-notifier";
  }
  const env = { [ENV_TITLE]: title, [ENV_MESSAGE]: message };
  if (await run(["osascript", "-e", MACOS_APPLESCRIPT], env)) {
    return "osascript";
  }
  return null;
}

/** Linux: notify-send (libnotify). Title/body are argv. "notify-send" or null. */
export async function notifyLinux(
  message: string,
  title: string,
  run: (cmd: string[], env?: Record<string, string>) => Promise<boolean> = runCmd,
): Promise<string | null> {
  if (await run(["notify-send", title, message])) return "notify-send";
  return null;
}

/** The per-OS notifier for the current platform (null worker on exotic OSes). */
export function platformWorker(
  platform: string = process.platform,
): (message: string, title: string) => Promise<string | null> {
  if (platform === "darwin") return (message, title) => notifyMacos(message, title);
  if (platform === "linux") return (message, title) => notifyLinux(message, title);
  return async () => null; // exotic platform: no desktop notifier to fall back to
}

/** Raise an OS-wide desktop notification; return the mechanism, or null. */
export async function notify(
  message: string,
  title: string = DEFAULT_TITLE,
  worker: (message: string, title: string) => Promise<string | null> = platformWorker(),
): Promise<string | null> {
  return worker(message, title);
}

export async function main(argv: string[]): Promise<number> {
  const prog = "os_notify.py";
  let parsed: ReturnType<
    typeof parseArgs<{
      options: { title: { type: "string" }; verbose: { type: "boolean"; short: "v" } };
      allowPositionals: true;
    }>
  >;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        title: { type: "string", default: DEFAULT_TITLE },
        verbose: { type: "boolean", short: "v" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    usageError(prog, err instanceof Error ? err.message : String(err));
  }
  const positionals = parsed.positionals;
  if (positionals.length !== 1) {
    process.stderr.write(`usage: ${prog} [-h] [--title TITLE] [-v] message\n`);
    process.exit(2);
  }
  const message = positionals[0] as string;
  const title = (parsed.values.title as string | undefined) ?? DEFAULT_TITLE;
  const verbose = parsed.values.verbose === true;

  const mechanism = await notify(message, title);
  if (mechanism === null) {
    // No notifier available -> exit 1, but don't lose the message: echo to stderr.
    process.stderr.write(`notify: no desktop notification mechanism available; ${title}: ${message}\n`);
    return 1;
  }
  if (verbose) {
    process.stderr.write(`notify: ${mechanism}\n`);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
