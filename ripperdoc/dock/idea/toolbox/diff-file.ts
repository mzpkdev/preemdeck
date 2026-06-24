#!/usr/bin/env bun
/**
 * diff-file.ts — diff two files in the running JetBrains IDE.
 *
 * The positionals map straight onto `idea diff`'s panes: `diff L R` (passthrough)
 * — `target` LEFT, `suggestion` RIGHT. Both inputs are resolved strictly, so a
 * missing path throws before anything launches. FIRE-AND-FORGET by default;
 * wait=true blocks on the IDE's native --wait, then reads back the LEFT pane.
 */

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { argparseError, argparseMessage } from "./cli.ts";
import { IdeaError } from "./core/errors.ts";
import { inIdea, launch } from "./core/index.ts";
import { resolveStrict } from "./tmp.ts";

const PROG = "diff-file";
const USAGE = "usage: diff-file [-h] [--wait] target suggestion";

/**
 * Engine seam: tests override these instead of mock.module on ./core (which
 * leaks across the single `bun test` run).
 */
export const _internals = {
  inIdea,
  launch,
  readFile: (path: string): Promise<string> => readFile(path, { encoding: "utf8" }),
};

/**
 * Open a 2-way (`target` vs `suggestion`) diff in the running JetBrains IDE.
 * Returns the LEFT (`target`) pane's text on the wait path, else null.
 */
export const diffFile = async (target: string, suggestion: string, wait = false): Promise<string | null> => {
  const targetAbs = await resolveStrict(target);
  const suggestionAbs = await resolveStrict(suggestion);
  const args = ["diff", targetAbs, suggestionAbs];
  // 2-way always watches `target` (LEFT). launch() owns the native --wait.
  await _internals.launch(args, { wait });
  return wait ? await _internals.readFile(targetAbs) : null;
};

/** CLI entrypoint: parse argv argparse-faithfully, gate on a live IDE, run diffFile, map errors to exit codes. */
export const main = async (argv: string[] = Bun.argv.slice(2)): Promise<number> => {
  let parsed: ReturnType<typeof parseArgs<{ options: { wait: { type: "boolean" } }; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: { wait: { type: "boolean" } }, allowPositionals: true });
  } catch (err) {
    argparseError(USAGE, PROG, argparseMessage(err));
  }
  const positionals = parsed.positionals;
  if (positionals.length < 2) {
    const missing = ["target", "suggestion"].slice(positionals.length).join(", ");
    argparseError(USAGE, PROG, `the following arguments are required: ${missing}`);
  }
  if (positionals.length > 2) {
    argparseError(USAGE, PROG, `unrecognized arguments: ${positionals.slice(2).join(" ")}`);
  }
  const wait = parsed.values.wait === true;

  let contents: string | null;
  try {
    // Cheap CLI gate: fail fast/clean outside a JetBrains terminal.
    if (!_internals.inIdea()) {
      throw new IdeaError("no JetBrains IDE in the process ancestry");
    }
    contents = await diffFile(positionals[0] as string, positionals[1] as string, wait);
  } catch (exc) {
    if (exc instanceof IdeaError || (exc instanceof Error && typeof (exc as NodeJS.ErrnoException).code === "string")) {
      process.stderr.write(`diff-file: ${exc.message}\n`);
      return 1;
    }
    throw exc;
  }
  if (contents !== null) {
    process.stdout.write(contents);
  }
  return 0;
};

if (import.meta.main) {
  process.exit(await main());
}
