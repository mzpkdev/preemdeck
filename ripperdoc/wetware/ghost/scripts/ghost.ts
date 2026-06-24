#!/usr/bin/env -S preemdeck-bun
/**
 * ghost.ts — persona obfuscation CLI.
 *
 *   encode    — for each MAPPING, base64-encode <MD> into <DAT> and unlink <MD>.
 *   decode    — for each MAPPING, base64-decode <DAT> back into <MD> (DAT kept).
 *   flatline  — copy stock/<MD> over <MD> for each mapping, then encode().
 *
 * Writes/unlinks `.dat`/`.md` in the plugin root. Base64 via `Buffer`. Unknown /
 * missing subcommand prints usage to stderr and exits 1.
 */

import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exists } from "../../../../lib/fs.ts";

/** The <MD> ⇄ <DAT> persona files, in the fixed order every subcommand walks. */
export const MAPPINGS: ReadonlyArray<readonly [string, string]> = [
  ["ENGRAM.md", "engram.dat"],
  ["FIRMWARE.md", "firmware.dat"],
  ["PULSE.md", "pulse.dat"],
];

/** The plugin root: CLAUDE_PLUGIN_ROOT || PLUGIN_ROOT || the script dir's parent. */
export const pluginRoot = (): string => {
  return process.env.CLAUDE_PLUGIN_ROOT || process.env.PLUGIN_ROOT || dirname(import.meta.dir);
};

/** base64-encode each present <MD> into <DAT> and remove the <MD>. */
export const encode = async (root: string, log: (line: string) => void = console.log): Promise<void> => {
  for (const [mdName, datName] of MAPPINGS) {
    const md = join(root, mdName);
    if (!(await exists(md))) continue;
    const dat = join(root, datName);
    // b64encode(md bytes) -> ASCII base64 bytes written verbatim to <DAT>.
    await writeFile(dat, Buffer.from(await readFile(md)).toString("base64"));
    await unlink(md);
    log(`${mdName} -> ${datName}`);
  }
};

/** base64-decode each present <DAT> back into <MD> (the <DAT> is left in place). */
export const decode = async (root: string, log: (line: string) => void = console.log): Promise<void> => {
  for (const [mdName, datName] of MAPPINGS) {
    const dat = join(root, datName);
    if (!(await exists(dat))) continue;
    const md = join(root, mdName);
    await writeFile(md, Buffer.from((await readFile(dat)).toString("utf8"), "base64"));
    log(`${datName} -> ${mdName}`);
  }
};

/** Restore stock/<MD> over <MD> for each mapping, then encode to scrub the .md. */
export const flatline = async (root: string, log: (line: string) => void = console.log): Promise<void> => {
  const stockDir = join(root, "stock");
  for (const [mdName] of MAPPINGS) {
    const src = join(stockDir, mdName);
    if (!(await exists(src))) continue;
    const dst = join(root, mdName);
    await writeFile(dst, await readFile(src));
  }
  await encode(root, log);
  log("persona wiped to stock");
};

/**
 * The CLI entry: dispatch the {encode|decode|flatline} subcommand. Returns the
 * process exit code (0 on a known command; 1 on an unknown/missing one, after
 * printing usage) rather than exiting, so tests can assert on it. `root`/`log`
 * are injectable for the suite.
 */
export const main = async (
  argv: string[],
  root: string = pluginRoot(),
  log: (line: string) => void = console.log,
): Promise<number> => {
  const cmd = argv.length > 0 ? argv[0] : undefined;
  if (cmd === "encode") {
    await encode(root, log);
  } else if (cmd === "decode") {
    await decode(root, log);
  } else if (cmd === "flatline") {
    await flatline(root, log);
  } else {
    process.stderr.write("Usage: ghost {encode|decode|flatline}\n");
    return 1;
  }
  return 0;
};

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
