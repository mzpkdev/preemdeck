#!/usr/bin/env bun
/**
 * open-file.ts — open a file in the running JetBrains IDE.
 *
 * FIRE-AND-FORGET by default (wait=false): launch() spawns the IDE async and the
 * call resolves null as soon as the process is started. With wait=true,
 * launch({wait:true}) appends the IDE's native --wait and blocks until the tab
 * closes; then reads the file back and returns its full text. launch() is the
 * single guard for a live IDE: it throws IdeaError if none is found.
 *
 * Opt-in preview=true layers a best-effort step AFTER the open: setPreview()
 * flips the editor to the rendered preview via ideScript. setPreview() never
 * throws: a failure degrades with a stderr note, so the open still succeeds.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { argparseError, argparseMessage } from "./cli.ts";
import { IdeaError } from "./core/errors.ts";
import { inIdea, launch, setPreview } from "./core/index.ts";

const PROG = "open-file";
const USAGE = "usage: open-file [-h] [--line LINE] [--column COLUMN] [--wait] [--preview]\n                 path";

/** argparse type=int parity: reject non-integers with the exact error message + exit 2. */
const parseIntArg = (name: string, raw: string): number => {
  if (!/^[+-]?\d+$/.test(raw.trim())) {
    argparseError(USAGE, PROG, `argument ${name}: invalid int value: '${raw}'`);
  }
  return Number.parseInt(raw, 10);
};

/**
 * Engine seam: tests override these instead of mock.module on ./core (which
 * leaks across the single `bun test` run).
 */
export const _internals = {
  inIdea,
  launch,
  setPreview,
  readFile: (path: string): Promise<string> => readFile(path, { encoding: "utf8" }),
};

/** Options for {@link openFile}: 1-based caret line/column, the wait toggle, and the rendered-preview opt-in. */
export type OpenFileOptions = {
  line?: number;
  column?: number | null;
  wait?: boolean;
  preview?: boolean;
};

/**
 * Open `path` at `line` (and optional `column`) in the running JetBrains IDE.
 * Returns the file's text on the wait path, else null (fire-and-forget).
 */
export const openFile = async (path: string, options: OpenFileOptions = {}): Promise<string | null> => {
  const line = options.line ?? 1;
  const column = options.column ?? null;
  const wait = options.wait ?? false;
  const preview = options.preview ?? false;

  const target = resolve(path);
  const args = ["--line", String(line)];
  if (column !== null) {
    args.push("--column", String(column));
  }
  args.push(target);
  await _internals.launch(args, { wait });
  if (preview) {
    await _internals.setPreview(target);
  }
  return wait ? await _internals.readFile(path) : null;
};

/** CLI entrypoint: parse argv argparse-faithfully (int line/column), gate on a live IDE, run openFile, map errors to exit codes. */
export const main = async (argv: string[] = Bun.argv.slice(2)): Promise<number> => {
  const options = {
    line: { type: "string" },
    column: { type: "string" },
    wait: { type: "boolean" },
    preview: { type: "boolean" },
  } as const;
  let parsed: ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true });
  } catch (err) {
    argparseError(USAGE, PROG, argparseMessage(err));
  }
  const path = parsed.positionals[0];
  if (path === undefined) {
    argparseError(USAGE, PROG, "the following arguments are required: path");
  }
  if (parsed.positionals.length > 1) {
    argparseError(USAGE, PROG, `unrecognized arguments: ${parsed.positionals.slice(1).join(" ")}`);
  }
  const line = parsed.values.line !== undefined ? parseIntArg("--line", parsed.values.line) : 1;
  const column = parsed.values.column !== undefined ? parseIntArg("--column", parsed.values.column) : null;
  const wait = parsed.values.wait === true;
  const preview = parsed.values.preview === true;

  let contents: string | null;
  try {
    // Cheap CLI gate: fail fast/clean outside a JetBrains terminal, before
    // launch()'s deeper resolveExecPath() ancestry walk.
    if (!_internals.inIdea()) {
      throw new IdeaError("no JetBrains IDE in the process ancestry");
    }
    contents = await openFile(path, { line, column, wait, preview });
  } catch (exc) {
    if (exc instanceof IdeaError) {
      process.stderr.write(`open-file: ${exc.message}\n`);
      return 1;
    }
    throw exc;
  }
  // Only --wait is result-aware: print the file text (no trailing newline added).
  if (contents !== null) {
    process.stdout.write(contents);
  }
  return 0;
};

if (import.meta.main) {
  process.exit(await main());
}
