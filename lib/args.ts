/**
 * lib/args.ts — the preemdeck CLI argument convention, on Node's `util.parseArgs`.
 *
 * This is the contract every ported toolbox command (open_url, in_idea, notify,
 * set_mode, …) parses its argv with, so they behave like the argparse originals:
 *
 *   - POSITIONALS: bare args, in order (e.g. the `url` / `value` operands).
 *     `allowPositionals` is on; read them from `result.positionals`.
 *   - BOOLEAN FLAGS: `{ type: "boolean" }` options (e.g. `-q`/`--quiet`, `--wait`).
 *   - INT options: declared `{ type: "string" }`, then run through `parseIntArg(name, raw)`
 *     which validates and exits 2 on a non-integer (matches argparse `type=int`).
 *   - REPEATABLE `--action`: `{ type: "string", multiple: true }`. Each value is
 *     split on the FIRST `=` only (`parseAction`) so `=` in URLs/paths survives,
 *     then whitelisted (`validateActions`) — an unknown name or a missing required
 *     arg exits 2, mirroring notify.py `_validate_action` -> ArgumentTypeError.
 *
 * USAGE ERRORS EXIT 2 (argparse's convention). `parseArgs` itself throws on an
 * unknown/badly-formed option; wrap the call in `parseOrExit` to turn that throw
 * (and our own validation failures via `usageError`) into a stderr line + exit 2.
 */

import { type ParseArgsConfig, parseArgs } from "node:util";

/** Thrown by validators to request a clean `exit 2` with a usage message. */
export class UsageError extends Error {}

/** Print `prog: <msg>` to stderr and exit 2 — the argparse usage-error contract. */
// The `=> never` lives on the variable type, not inline on the arrow: only an
// explicitly-typed `never`-returning binding drives call-site control-flow
// analysis (an inline `(): never =>` does not), so callers like `parseOrExit`
// and every `main` are correctly seen as terminating. See cli.ts `argparseError`.
export const usageError: (prog: string, message: string) => never = (prog, message) => {
  process.stderr.write(`${prog}: ${message}\n`);
  process.exit(2);
};

/**
 * Run `parseArgs`, converting any thrown parse error (and any `UsageError` from
 * downstream validation you call inside `then`-ish code) into stderr + exit 2.
 * `config.args` defaults to `Bun.argv.slice(2)` (the args after the script path).
 */
export const parseOrExit = <T extends ParseArgsConfig>(prog: string, config: T): ReturnType<typeof parseArgs<T>> => {
  try {
    return parseArgs<T>({ args: Bun.argv.slice(2), ...config });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    usageError(prog, message);
  }
};

/**
 * Parse an int option value the way argparse `type=int` does. `raw` is the
 * string `parseArgs` captured; returns the integer or exits 2 with a usage error.
 * `name` heads the error (e.g. "--timeout").
 */
export const parseIntArg = (prog: string, name: string, raw: string): number => {
  // Reject anything that isn't a clean optional-sign integer (no floats, no "3abc").
  if (!/^[+-]?\d+$/.test(raw.trim())) {
    usageError(prog, `argument ${name}: invalid int value: '${raw}'`);
  }
  return Number.parseInt(raw, 10);
};

/** One parsed `--action`: its `name`, and the `=arg` payload (`null` when bare). */
export type Action = { name: string; arg: string | null };

/** Whitelist entry per action name: `[needsArg]`. Extend the tuple as porting needs. */
export type ActionSpec = Record<string, { needsArg: boolean }>;

/**
 * Split a `--action` value into `{name, arg}` on the FIRST `=` only.
 * `name=arg` -> `{name, arg}`; bare `name` -> `{name, arg: null}`. Matches
 * notify.py `_parse_action` (so `=` inside a URL/path query stays in `arg`).
 */
export const parseAction = (value: string): Action => {
  const eq = value.indexOf("=");
  if (eq === -1) return { name: value, arg: null };
  return { name: value.slice(0, eq), arg: value.slice(eq + 1) };
};

/**
 * Parse + whitelist a list of raw `--action` values against `spec`. Returns the
 * vetted `Action[]` in CLI order, or exits 2 (usage error) when a name is not in
 * `spec` or a `needsArg` action is missing its arg — mirrors notify.py
 * `_validate_action`. `raw` is `result.values.action` (string[] | undefined).
 */
export const validateActions = (prog: string, raw: string[] | undefined, spec: ActionSpec): Action[] => {
  const out: Action[] = [];
  for (const value of raw ?? []) {
    const { name, arg } = parseAction(value);
    const entry = spec[name];
    if (!entry) {
      const allowed = Object.keys(spec).sort().join(", ");
      usageError(prog, `unknown action '${name}' (choose from ${allowed})`);
    }
    if (entry.needsArg && (arg === null || arg.length === 0)) {
      usageError(prog, `action '${name}' needs an argument: --action ${name}=<value>`);
    }
    out.push({ name, arg });
  }
  return out;
};
