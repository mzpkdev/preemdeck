#!/usr/bin/env bun
/**
 * in_idea.ts — report whether this terminal is running inside a JetBrains IDE.
 * Behavior-identical TS port of in_idea.py (additive — the .py stays live until
 * the flip phase).
 *
 * The same cheap gate every other tool applies before it acts: true when this
 * terminal was launched by a JetBrains IDE, false otherwise. The result is the
 * process exit code (0 inside, 1 outside) so it doubles as a shell gate; without
 * -q it also prints a human-readable line.
 */

import { parseArgs } from "node:util";
import { argparseError, argparseMessage } from "./_cli.ts";
import { NotImplementedError } from "./core/_errors.ts";
import { inIdea } from "./core/index.ts";

const PROG = "in_idea.py";
const USAGE = "usage: in_idea.py [-h] [-q]";

// Engine seam: tests override `_internals.inIdea` instead of mock.module on
// ./core (which leaks across the single `bun test` run). Production reads the
// real detector.
export const _internals = { inIdea };

export function main(argv: string[] = Bun.argv.slice(2)): number {
  let parsed: ReturnType<
    typeof parseArgs<{ options: { quiet: { type: "boolean"; short: "q" } }; allowPositionals: true }>
  >;
  try {
    parsed = parseArgs({ args: argv, options: { quiet: { type: "boolean", short: "q" } }, allowPositionals: true });
  } catch (err) {
    argparseError(USAGE, PROG, argparseMessage(err));
  }
  const quiet = parsed.values.quiet === true;
  let inside: boolean;
  try {
    inside = _internals.inIdea();
  } catch (exc) {
    if (exc instanceof NotImplementedError) {
      process.stderr.write(`in_idea: ${exc.message}\n`);
      return 1;
    }
    throw exc;
  }
  if (!quiet) {
    console.log(inside ? "in a JetBrains IDE terminal" : "not in a JetBrains IDE terminal");
  }
  return inside ? 0 : 1;
}

if (import.meta.main) {
  process.exit(main());
}
