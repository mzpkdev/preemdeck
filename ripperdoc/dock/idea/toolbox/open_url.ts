#!/usr/bin/env bun
/**
 * open_url.ts — open an http/https URL in the running JetBrains IDE's embedded
 * JCEF preview. Behavior-identical TS port of open_url.py (additive — the .py
 * stays live).
 *
 * FIRE-AND-FORGET: there is no editor to block on, so unlike open_file there is
 * no --wait. Clean-fail, NOT a browser fallback: resolveExecPath() is the single
 * guard for a live IDE — it throws IdeaError / NotImplementedError, which the CLI
 * turns into a non-zero exit. With a live IDE confirmed, previewUrl() fires the
 * ideScript.
 */

import { parseArgs } from "node:util";
import { parseUrl } from "../../../../lib/text.ts";
import { argparseError, argparseMessage } from "./_cli.ts";
import { IdeaError, NotImplementedError } from "./core/_errors.ts";
import { inIdea, previewUrl, resolveExecPath } from "./core/index.ts";

const PROG = "open_url.py";
const USAGE = "usage: open_url.py [-h] [--title TITLE] url";

// Engine seam: tests override these instead of mock.module on ./core (which
// leaks across the single `bun test` run).
export const _internals = { inIdea, resolveExecPath, previewUrl };

/**
 * Open `url` in the running IDE's embedded JCEF web-preview tab. resolveExecPath()
 * is the single guard for a live IDE; then previewUrl() fires the ideScript.
 */
export async function openUrl(url: string, title?: string): Promise<void> {
  _internals.resolveExecPath();
  await _internals.previewUrl(url, title);
}

export async function main(argv: string[] = Bun.argv.slice(2)): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: { title: { type: "string" } }; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: { title: { type: "string" } }, allowPositionals: true });
  } catch (err) {
    argparseError(USAGE, PROG, argparseMessage(err));
  }
  const url = parsed.positionals[0];
  if (url === undefined) {
    argparseError(USAGE, PROG, "the following arguments are required: url");
  }
  if (parsed.positionals.length > 1) {
    argparseError(USAGE, PROG, `unrecognized arguments: ${parsed.positionals.slice(1).join(" ")}`);
  }
  const title = parsed.values.title;
  // Light validation: a non-empty http/https URL. The IDE's JCEF preview only
  // speaks http(s), so reject anything else up front with a clear note.
  if (!["http", "https"].includes(parseUrl(url).scheme)) {
    process.stderr.write("open_url: url must be a non-empty http/https URL\n");
    return 1;
  }
  try {
    // Cheap CLI gate: fail fast/clean outside a JetBrains terminal, before
    // resolveExecPath()'s deeper ancestry walk.
    if (!_internals.inIdea()) {
      throw new IdeaError("no JetBrains IDE in the process ancestry");
    }
    await openUrl(url, title);
  } catch (exc) {
    if (exc instanceof IdeaError || exc instanceof NotImplementedError) {
      process.stderr.write(`open_url: ${exc.message}\n`);
      return 1;
    }
    throw exc;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
