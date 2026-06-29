#!/usr/bin/env bun
/**
 * update.ts — preemdeck self-update.
 *
 * "Update" is not a bespoke path: it is re-running the canonical boot.sh — pull the
 * selected channel into ~/.preemdeck and re-install every detected harness. install.ts
 * is already update-aware (the mirror is rebuilt from scratch so stale primitives can't
 * survive, every manifest is re-stamped with `git describe` to bust the host plugin
 * cache, the overlay is backed-up-once and the install manifest is merged per-harness),
 * so a clean re-install IS the update.
 *
 * This wrapper just makes that one user-facing action ergonomic + reports what moved:
 *   1. verify ~/.preemdeck is a git checkout (else preemdeck wasn't installed via boot.sh),
 *   2. record the current `git describe`,
 *   3. STREAM `curl -fsSL <boot.sh> | bash -s -- <args>` (the documented update flow;
 *      channel is selected by boot.sh itself via PREEMDECK_CHANNEL, default stable),
 *   4. report old → new version + the restart reminder.
 *
 * Why re-fetch boot.sh over the network instead of running the local copy: boot.sh
 * `git reset --hard`s ~/.preemdeck mid-run, and modifying a shell script while bash is
 * reading it corrupts execution — so the bootstrap must come from a source the reset
 * can't touch. update.ts itself is immune: Bun loads this module into memory at startup,
 * so the reset of ~/.preemdeck/update.ts on disk can't pull it out from under us.
 *
 * Zero third-party imports (like install.ts): update RUNS the installer, which installs
 * node_modules, so update must load even when none exist yet. Shell-outs go through
 * process.ts `reap`; the streaming boot child inherits stdio and is awaited directly.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { CHECK, CROSS, HOSTS } from "./install";
import { PIPED, reap } from "./src/common/process";

// update.ts lives beside install.ts/uninstall.ts (~/.preemdeck when deployed), so this
// resolves to the same REPO_ROOT — the git checkout boot.sh fetches into.
export const REPO_ROOT = import.meta.dir;

// The canonical bootstrap entrypoint: always main's boot.sh. boot.sh resolves the
// channel itself (PREEMDECK_CHANNEL, default stable) and re-installs every detected
// harness — this mirrors the documented `curl … boot.sh | bash` update command.
export const BOOT_URL = "https://raw.githubusercontent.com/mzpkdev/preemdeck/main/boot.sh";

export interface UpdateArgs {
  // Explicit harness targets forwarded to boot.sh → install.ts. EMPTY = auto-detect
  // every installed host (boot.sh's default), exactly as a bare re-install would.
  harnesses: string[];
}

export function parseUpdateArgs(argv: string[]): UpdateArgs {
  // Hand-rolled (no argvex), mirroring install.ts: update runs the installer, which
  // installs node_modules, so update must also load with zero third-party imports.
  const prog = "update.ts";
  const positionals: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("-")) {
      // No flags: --dry-run would be misleading here (boot.sh's fetch + reset --hard
      // are NOT dry, only install.ts's writes would be), so reject it like any option.
      process.stderr.write(`${prog}: unrecognized option: ${arg}\n`);
      process.exit(2);
    }
    positionals.push(arg);
  }
  for (const harness of positionals) {
    if (!HOSTS.includes(harness)) {
      process.stderr.write(
        `${prog}: argument harness: invalid choice: '${harness}' (choose from ${HOSTS.join(", ")})\n`,
      );
      process.exit(2);
    }
  }
  return { harnesses: positionals };
}

/**
 * `git -C <repoRoot> describe --tags --always`, or "" when not a git repo / git missing.
 *
 * Same describe install.ts stamps the mirror with: the release tag on a tagged HEAD
 * (stable), else a short SHA (edge). Used only for the before/after report, so any
 * failure degrades to "" rather than aborting the update.
 */
export async function describeVersion(repoRoot: string): Promise<string> {
  try {
    const r = await reap(Bun.spawn(["git", "-C", repoRoot, "describe", "--tags", "--always"], PIPED), 10_000);
    return r.exitCode === 0 ? r.stdout.trim() : "";
  } catch {
    return "";
  }
}

/**
 * Build the `bash -c` argv that streams the canonical boot.sh, forwarding `forward`.
 *
 * `set -o pipefail` makes a curl failure (offline, 404) fail the pipe instead of
 * silently feeding empty input to bash. `bash -s -- "${@:2}"` passes our forwarded
 * args to the piped script ($0="bash", $1=url, $2…=forward).
 */
export function bootCommand(url: string, forward: string[]): string[] {
  const script = 'set -o pipefail; curl -fsSL "$1" | bash -s -- "${@:2}"';
  return ["bash", "-c", script, "bash", url, ...forward];
}

export async function main(argv: string[] = Bun.argv.slice(2), repoRoot: string = REPO_ROOT): Promise<number> {
  const args = parseUpdateArgs(argv);

  // ~/.preemdeck must be the git checkout boot.sh fetches into. If it isn't, preemdeck
  // wasn't installed via boot.sh and a re-fetch + reset --hard has nothing to act on.
  if (!existsSync(join(repoRoot, ".git"))) {
    process.stderr.write(
      `${repoRoot} is not a git checkout — preemdeck wasn't installed via boot.sh, nothing to update.\n` +
        `Install it first:\n  curl -fsSL ${BOOT_URL} | bash\n`,
    );
    return 1;
  }

  const before = await describeVersion(repoRoot);
  console.log(`preemdeck update — current ${before || "unknown"}`);
  console.log("  pulling latest + re-slotting via boot.sh…");
  console.log();

  // Stream boot.sh live (inherit stdio) so the operator sees install.ts's banner/phases
  // as they happen. We're already in memory, so boot.sh's reset --hard of ~/.preemdeck
  // can't corrupt this running script (see the file docblock).
  const child = Bun.spawn(bootCommand(BOOT_URL, args.harnesses), {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  await child.exited;

  console.log();
  if (child.exitCode !== 0) {
    console.log(`  ${CROSS} update failed (boot.sh exited ${child.exitCode}) — see output above.`);
    return child.exitCode ?? 1;
  }

  const after = await describeVersion(repoRoot);
  if (before && after && before !== after) {
    console.log(`  ${CHECK} updated ${before} → ${after}`);
  } else if (after) {
    console.log(`  ${CHECK} already current at ${after}`);
  } else {
    console.log(`  ${CHECK} update complete`);
  }
  console.log("  restart your CLI to load the refreshed rig.");
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
