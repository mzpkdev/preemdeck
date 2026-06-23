#!/usr/bin/env bun
/**
 * open_inline.ts — open an inline string in the running JetBrains IDE via a temp
 * file. Behavior-identical TS port of open_inline.py (additive — the .py stays
 * live).
 *
 * A thin string-native wrapper over open_file: the string is spilled to a temp
 * file (named with `suffix` so the IDE picks the right syntax highlighting),
 * opened, and — on the wait path — the edited text is handed back. The IDE only
 * opens files, so the temp is the bridge.
 */

import { unlinkSync } from "node:fs";
import { parseArgs } from "node:util";
import { argparseError, argparseMessage } from "./_cli.ts";
import { mkstempSync, writeTemp } from "./_tmp.ts";
import { IdeaError } from "./core/_errors.ts";
import { inIdea, reapLater } from "./core/index.ts";
import { openFile } from "./open_file.ts";

const PROG = "open_inline.py";
const USAGE = "usage: open_inline.py [-h] [--suffix SUFFIX] [--wait] [--preview] inline";

// Engine + worker seam: tests override these instead of mock.module on ./core
// (which leaks across the single `bun test` run). `openFile` is the delegate the
// worker drives; `openInline` is the worker the CLI drives — both are overridable
// the way the Python suite monkeypatches `open_inline.open_file` / `.open_inline`.
export const _internals = { inIdea, openFile, reapLater, openInline };

export interface OpenInlineOptions {
  suffix?: string;
  wait?: boolean;
  preview?: boolean;
}

/**
 * Open `content` in the running JetBrains IDE by routing it through a temp file.
 *
 * wait=true  -> open_file blocks and returns the edited text; unlink the temp,
 *   return the text. wait=false -> open_file launched async; schedule a deferred
 *   reap (reapLater) and return null.
 */
export async function openInline(content: string, options: OpenInlineOptions = {}): Promise<string | null> {
  const suffix = options.suffix ?? ".txt";
  const wait = options.wait ?? false;
  const preview = options.preview ?? false;

  const path = await writeTemp(content, suffix);
  try {
    const contents = await _internals.openFile(path, { wait, preview });
    if (wait) {
      return contents;
    }
    // Fire-and-forget: the IDE was launched async and is (or will be) reading
    // `path`, so deleting it now would yank the file out from under the editor.
    _internals.reapLater([path]);
    return null;
  } finally {
    // Only the wait=true path is safe to clean up synchronously here.
    if (wait) {
      unlinkSync(path);
    }
  }
}

export async function main(argv: string[] = Bun.argv.slice(2)): Promise<number> {
  const options = {
    suffix: { type: "string" },
    wait: { type: "boolean" },
    preview: { type: "boolean" },
  } as const;
  let parsed: ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true });
  } catch (err) {
    argparseError(USAGE, PROG, argparseMessage(err));
  }
  const inline = parsed.positionals[0];
  if (inline === undefined) {
    argparseError(USAGE, PROG, "the following arguments are required: inline");
  }
  if (parsed.positionals.length > 1) {
    argparseError(USAGE, PROG, `unrecognized arguments: ${parsed.positionals.slice(1).join(" ")}`);
  }
  const suffix = parsed.values.suffix ?? ".txt";
  const wait = parsed.values.wait === true;
  const preview = parsed.values.preview === true;

  let contents: string | null;
  try {
    if (!_internals.inIdea()) {
      throw new IdeaError("no JetBrains IDE in the process ancestry");
    }
    contents = await _internals.openInline(inline, { suffix, wait, preview });
  } catch (exc) {
    if (exc instanceof IdeaError) {
      process.stderr.write(`open_inline: ${exc.message}\n`);
      return 1;
    }
    throw exc;
  }
  if (contents !== null) {
    process.stdout.write(contents);
  }
  return 0;
}

// Re-export so a future caller can mint temps the same way (parity with mkstemp).
export { mkstempSync };

if (import.meta.main) {
  process.exit(await main());
}
