#!/usr/bin/env bun
/**
 * merge-file.ts — 3-way merge of two files (with an optional base) in the running
 * JetBrains IDE.
 *
 * The positionals are READ-ONLY inputs resolved strictly (a missing path throws
 * before launch). They map onto `idea merge`'s fixed arg order, OUTPUT LAST and
 * BASE (when present) THIRD: `merge <local> <remote> [<base>] <output>`. The
 * resolution lands in an internal output temp minted here, suffixed to mirror the
 * target's extension.
 *
 * Unlike diff, `idea merge` BLOCKS natively until Apply — there is no --wait flag.
 * So launch() is called with the default (async spawn, no --wait) and the process
 * is joined here via `await child.exited` (Python's proc.wait()).
 */

import { readFile, unlink } from "node:fs/promises";
import { extname } from "node:path";
import { parseArgs } from "node:util";
import { argparseError, argparseMessage } from "./cli.ts";
import { IdeaError } from "./core/errors.ts";
import { inIdea, launch, reapLater } from "./core/index.ts";
import { mkstemp, resolveStrict } from "./tmp.ts";

const PROG = "merge-file";
const USAGE = "usage: merge-file [-h] [--wait] target suggestion [base]";

/**
 * Engine seam: tests override these instead of mock.module on ./core (which
 * leaks across the single `bun test` run). `launch` returns a child handle whose
 * `.exited` Promise is the native-merge join (Python's proc.wait()).
 */
export const _internals = {
  inIdea,
  launch,
  reapLater,
  readFile: (path: string): Promise<string> => readFile(path, { encoding: "utf8" }),
};

/** Open a 3-way merge of `target`/`suggestion` (optional `base`) in the IDE. */
export const mergeFile = async (
  target: string,
  suggestion: string,
  base: string | null = null,
  wait = false,
): Promise<string | null> => {
  const targetAbs = await resolveStrict(target);
  const suggestionAbs = await resolveStrict(suggestion);
  const baseAbs = base !== null ? await resolveStrict(base) : null;

  // Internal output temp (not a caller arg). Mirror the target's extension for
  // syntax highlighting when it has one, else a plain default.
  const suffix = extname(targetAbs) || ".txt";
  const output = await mkstemp(suffix);

  // Fixed arg order: output LAST, base THIRD when present. No --wait — merge
  // blocks natively; spawn async and join the process below.
  const argv =
    baseAbs === null
      ? ["merge", targetAbs, suggestionAbs, output]
      : ["merge", targetAbs, suggestionAbs, baseAbs, output];
  const child = await _internals.launch(argv);

  if (!wait) {
    // Fire-and-forget: the IDE may still write `output` after Apply; defer the reap.
    _internals.reapLater([output]);
    return null;
  }
  try {
    // merge blocks natively; joining the spawned process waits for Apply.
    await child.exited;
    return await _internals.readFile(output);
  } finally {
    await unlink(output);
  }
};

/** CLI entrypoint: parse argv argparse-faithfully, gate on a live IDE, run mergeFile, map errors to exit codes. */
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
  if (positionals.length > 3) {
    argparseError(USAGE, PROG, `unrecognized arguments: ${positionals.slice(3).join(" ")}`);
  }
  const base = positionals.length >= 3 ? (positionals[2] as string) : null;
  const wait = parsed.values.wait === true;

  let result: string | null;
  try {
    if (!_internals.inIdea()) {
      throw new IdeaError("no JetBrains IDE in the process ancestry");
    }
    result = await mergeFile(positionals[0] as string, positionals[1] as string, base, wait);
  } catch (exc) {
    if (exc instanceof IdeaError || (exc instanceof Error && typeof (exc as NodeJS.ErrnoException).code === "string")) {
      process.stderr.write(`merge-file: ${exc.message}\n`);
      return 1;
    }
    throw exc;
  }
  if (result !== null) {
    process.stdout.write(result);
  }
  return 0;
};

if (import.meta.main) {
  process.exit(await main());
}
