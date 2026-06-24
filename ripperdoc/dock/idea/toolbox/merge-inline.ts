#!/usr/bin/env bun
/**
 * merge-inline.ts — 3-way merge of inline strings (with an optional base) in the
 * running JetBrains IDE.
 *
 * A string-native wrapper over mergeFile: each version is spilled to a temp file
 * — `target`, `suggestion`, and `base` ONLY when not null — and handed to
 * mergeFile (which mints its own internal OUTPUT temp). wait=true: mergeFile
 * blocks until Apply and returns the result; unlink the input temps. wait=false:
 * mergeFile launched async; schedule a deferred reap for the input temps and
 * return null. The OUTPUT temp is mergeFile's to reap.
 */

import { unlinkSync } from "node:fs";
import { parseArgs } from "node:util";
import { argparseError, argparseMessage } from "./cli.ts";
import { IdeaError } from "./core/errors.ts";
import { inIdea, reapLater } from "./core/index.ts";
import { mergeFile } from "./merge-file.ts";
import { writeTemp } from "./tmp.ts";

const PROG = "merge-inline";
const USAGE = "usage: merge-inline [-h] [--suffix SUFFIX] [--wait]\n                    target suggestion [base]";

/** Options for {@link mergeInline}: the temp-file suffix (drives IDE syntax highlighting) and the wait toggle. */
export type MergeInlineOptions = {
  suffix?: string;
  wait?: boolean;
};

/** Merge inline strings by spilling each to a temp file, then delegating to mergeFile. */
export const mergeInline = async (
  target: string,
  suggestion: string,
  base: string | null = null,
  options: MergeInlineOptions = {},
): Promise<string | null> => {
  const suffix = options.suffix ?? ".txt";
  const wait = options.wait ?? false;
  const temps: string[] = [];
  try {
    const targetTmp = await writeTemp(target, suffix);
    temps.push(targetTmp);
    const suggestionTmp = await writeTemp(suggestion, suffix);
    temps.push(suggestionTmp);
    let baseTmp: string | null = null;
    if (base !== null) {
      baseTmp = await writeTemp(base, suffix);
      temps.push(baseTmp);
    }
    const result = await _internals.mergeFile(targetTmp, suggestionTmp, baseTmp, wait);
    if (!wait) {
      // Fire-and-forget: the IDE still has the input temps open; defer the reap.
      // The output temp is mergeFile's to reap, so it's not in `temps`.
      _internals.reapLater(temps);
    }
    return result;
  } finally {
    // wait=true: mergeFile already returned, input temps are spent — remove now.
    if (wait) {
      for (const path of temps) {
        unlinkSync(path);
      }
    }
  }
};

/**
 * Engine + worker seam: tests override these instead of mock.module on ./core
 * (which leaks across the single `bun test` run): the mergeFile delegate, the
 * reaper, and mergeInline itself.
 */
export const _internals = { inIdea, mergeFile, reapLater, mergeInline };

/** CLI entrypoint: parse argv argparse-faithfully, gate on a live IDE, run mergeInline, map errors to exit codes. */
export const main = async (argv: string[] = Bun.argv.slice(2)): Promise<number> => {
  const options = { suffix: { type: "string" }, wait: { type: "boolean" } } as const;
  let parsed: ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true });
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
  const suffix = parsed.values.suffix ?? ".txt";
  const wait = parsed.values.wait === true;

  let result: string | null;
  try {
    if (!_internals.inIdea()) {
      throw new IdeaError("no JetBrains IDE in the process ancestry");
    }
    result = await _internals.mergeInline(positionals[0] as string, positionals[1] as string, base, { suffix, wait });
  } catch (exc) {
    if (exc instanceof IdeaError || (exc instanceof Error && typeof (exc as NodeJS.ErrnoException).code === "string")) {
      process.stderr.write(`merge-inline: ${exc.message}\n`);
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
