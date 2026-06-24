#!/usr/bin/env bun
/**
 * read-logs.ts — read the last N lines of the running JetBrains IDE's log.
 * Behavior-identical TS port of read_logs.py (additive — the .py stays live).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { argparseError, argparseMessage } from "./cli.ts";
import { IdeaError } from "./core/errors.ts";
import { inIdea, resolveLogDir } from "./core/index.ts";

const PROG = "read_logs.py";
const USAGE = "usage: read_logs.py [-h] [n]";

/** argparse type=int parity: reject non-integers with the exact error message + exit 2. */
const parseIntArg = (name: string, raw: string): number => {
  if (!/^[+-]?\d+$/.test(raw.trim())) {
    argparseError(USAGE, PROG, `argument ${name}: invalid int value: '${raw}'`);
  }
  return Number.parseInt(raw, 10);
};

/**
 * Engine seam: tests override these instead of mock.module on ./core (which
 * leaks across the single `bun test` run). Production reads the real detector /
 * resolver / FS read.
 */
export const _internals = {
  inIdea,
  resolveLogDir,
  readFile: (path: string): string => readFileSync(path, { encoding: "latin1" }),
};

/**
 * Split `text` into lines the way Python's str.splitlines() does for log files:
 * on \r\n / \n / \r, dropping the trailing empty segment after a final
 * terminator (so "a\nb\n" -> ["a", "b"], matching read_logs.py's
 * read_text().splitlines()). Other Unicode line boundaries are vanishingly rare
 * in idea.log and out of scope.
 */
const splitLines = (text: string): string[] => {
  if (text === "") {
    return [];
  }
  const lines = text.split(/\r\n|\r|\n/);
  // Python's splitlines() yields no trailing "" after a final line break.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
};

/**
 * Last `n` lines of the active IDE's idea.log.
 *
 * resolveLogDir() is the single guard for a live IDE: it throws IdeaError if
 * none is found.
 */
export const readLogs = (n = 50): string[] => {
  const log = join(_internals.resolveLogDir(), "idea.log");
  // errors="replace" parity: read as latin1 so every byte decodes (no throw),
  // matching read_text(errors="replace") for the tail use case.
  const lines = splitLines(_internals.readFile(log));
  // Python slices lines[-n:]. Replicate its semantics exactly: n>0 -> last n;
  // n==0 -> all (Python's [-0:] is [0:]); n<0 -> drop the first |n|.
  return lines.slice(n > 0 ? Math.max(0, lines.length - n) : -n);
};

/** CLI entrypoint: parse argv argparse-faithfully (int n), gate on a live IDE, run readLogs, map errors to exit codes. */
export const main = (argv: string[] = Bun.argv.slice(2)): number => {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true });
  } catch (err) {
    argparseError(USAGE, PROG, argparseMessage(err));
  }
  const positionals = parsed.positionals;
  if (positionals.length > 1) {
    argparseError(USAGE, PROG, `unrecognized arguments: ${positionals.slice(1).join(" ")}`);
  }
  const n = positionals.length > 0 ? parseIntArg("n", positionals[0] as string) : 50;
  let lines: string[];
  try {
    // Cheap CLI gate: fail fast/clean outside a JetBrains terminal, before
    // resolveLogDir()'s deeper resolveExecPath() ancestry walk. Reuse the
    // IdeaError path so the message matches the resolver-triggered failure.
    if (!_internals.inIdea()) {
      throw new IdeaError("no JetBrains IDE in the process ancestry");
    }
    lines = readLogs(n);
  } catch (exc) {
    if (exc instanceof IdeaError || (exc instanceof Error && typeof (exc as NodeJS.ErrnoException).code === "string")) {
      process.stderr.write(`read_logs: ${exc.message}\n`);
      return 1;
    }
    throw exc;
  }
  console.log(lines.join("\n"));
  return 0;
};

if (import.meta.main) {
  process.exit(main());
}
