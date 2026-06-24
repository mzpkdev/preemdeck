/**
 * cli.ts — argparse-faithful usage/error emission for the toolbox CLIs.
 *
 * argparse prints TWO lines on a usage error: a wrapped `usage: <prog> ...`
 * synopsis, then `<prog>: error: <message>`, and exits 2. lib/args.ts's
 * usageError emits only the second-style line; these toolbox commands are
 * user-facing and golden-diffed against the Python argparse output, so they
 * reproduce both lines verbatim. Each CLI passes its own static `usage` synopsis
 * (copied from the argparse render) and the argparse `error:` message.
 */

/** Print argparse's two-line usage error (`usage:` synopsis + `prog: error: msg`) and exit 2. */
export const argparseError: (usage: string, prog: string, message: string) => never = (usage, prog, message) => {
  process.stderr.write(`${usage}\n`);
  process.stderr.write(`${prog}: error: ${message}\n`);
  process.exit(2);
};

/**
 * Rewrite Node's `util.parseArgs` throw into argparse's equivalent error string,
 * so the golden stderr matches the Python CLIs byte-for-byte. parseArgs reports
 * an unknown flag as `Unknown option '--x'. To specify...`; argparse reports
 * `unrecognized arguments: --x`. Other parseArgs errors (e.g. an option missing
 * its value) are passed through — they're not exercised by the toolbox's tests.
 */
export const argparseMessage = (err: unknown): string => {
  const raw = err instanceof Error ? err.message : String(err);
  const unknown = raw.match(/^Unknown option '([^']+)'/);
  if (unknown) {
    // argparse strips a `=value` suffix and reports just the flag token.
    const flag = (unknown[1] as string).split("=")[0];
    return `unrecognized arguments: ${flag}`;
  }
  return raw;
};
