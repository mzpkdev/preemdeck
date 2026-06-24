#!/usr/bin/env bun
/**
 * diff-inline.ts — diff two inline strings in the running JetBrains IDE.
 *
 * A string-native wrapper over diffFile: each version is spilled to a temp file
 * — `target` -> left, `suggestion` -> right — and handed to diffFile in
 * positional order. wait=true: diffFile blocks and returns the LEFT pane's text;
 * unlink both temps. wait=false: diffFile launched async; schedule a deferred
 * reap for both temps and return null.
 */

import { unlinkSync } from "node:fs";
import { parseArgs } from "node:util";
import { argparseError, argparseMessage } from "./cli.ts";
import { IdeaError } from "./core/errors.ts";
import { inIdea, reapLater } from "./core/index.ts";
import { diffFile } from "./diff-file.ts";
import { writeTemp } from "./tmp.ts";

const PROG = "diff-inline";
const USAGE = "usage: diff-inline [-h] [--suffix SUFFIX] [--wait] target suggestion";

/** Options for {@link diffInline}: the temp-file suffix (drives IDE syntax highlighting) and the wait toggle. */
export type DiffInlineOptions = {
  suffix?: string;
  wait?: boolean;
};

/** Diff inline strings by spilling each to a temp file, then delegating to diffFile. */
export const diffInline = async (
  target: string,
  suggestion: string,
  options: DiffInlineOptions = {},
): Promise<string | null> => {
  const suffix = options.suffix ?? ".txt";
  const wait = options.wait ?? false;
  const temps: string[] = [];
  try {
    const targetTmp = await writeTemp(target, suffix);
    temps.push(targetTmp);
    const suggestionTmp = await writeTemp(suggestion, suffix);
    temps.push(suggestionTmp);
    const contents = await _internals.diffFile(targetTmp, suggestionTmp, wait);
    if (!wait) {
      // Fire-and-forget: the IDE still has both temps open; defer the reap.
      _internals.reapLater([targetTmp, suggestionTmp]);
    }
    return contents;
  } finally {
    // wait=true: diffFile already returned, temps are spent — remove now.
    if (wait) {
      for (const path of temps) {
        unlinkSync(path);
      }
    }
  }
};

/**
 * Engine + worker seam: tests override these instead of mock.module on ./core
 * (which leaks across the single `bun test` run): the diffFile delegate, the
 * reaper, and diffInline itself.
 */
export const _internals = { inIdea, diffFile, reapLater, diffInline };

/** CLI entrypoint: parse argv argparse-faithfully, gate on a live IDE, run diffInline, map errors to exit codes. */
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
  if (positionals.length > 2) {
    argparseError(USAGE, PROG, `unrecognized arguments: ${positionals.slice(2).join(" ")}`);
  }
  const suffix = parsed.values.suffix ?? ".txt";
  const wait = parsed.values.wait === true;

  let contents: string | null;
  try {
    if (!_internals.inIdea()) {
      throw new IdeaError("no JetBrains IDE in the process ancestry");
    }
    contents = await _internals.diffInline(positionals[0] as string, positionals[1] as string, { suffix, wait });
  } catch (exc) {
    if (exc instanceof IdeaError || (exc instanceof Error && typeof (exc as NodeJS.ErrnoException).code === "string")) {
      process.stderr.write(`diff-inline: ${exc.message}\n`);
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
