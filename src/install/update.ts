/**
 * update core — preemdeck self-update.
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
 *   3. read the channel this install tracks from preemdeck.json and forward it as
 *      PREEMDECK_CHANNEL, so update re-fetches the SAME stream instead of boot.sh's
 *      stable default (an explicit PREEMDECK_CHANNEL in the environment still wins),
 *   4. STREAM `curl -fsSL <boot.sh> | bash -s -- <args>` (the documented update flow),
 *   5. report old → new version + the restart reminder.
 *
 * Zero third-party imports (like install.ts): update RUNS the installer, which installs
 * node_modules, so update must load even when none exist yet. Shell-outs go through
 * process.ts `reap`; the streaming boot child inherits stdio and is awaited directly.
 * `repoRoot` is threaded from the entry (import.meta.dir).
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { PIPED, reap } from "../common/process"
import { parseUpdateArgs } from "./args"
import { readChannel } from "./config"
import { CHECK, CROSS } from "./skin"

// The canonical bootstrap entrypoint: always main's boot.sh. boot.sh maps the channel
// (PREEMDECK_CHANNEL, default stable) to a branch and re-installs every detected harness.
// update forwards the installed channel — read from preemdeck.json (main()) — via that
// env var, mirroring the documented `curl … boot.sh | bash` command without the stable snap.
export const BOOT_URL = "https://raw.githubusercontent.com/mzpkdev/preemdeck/main/boot.sh"

/**
 * `git -C <repoRoot> describe --tags --always`, or "" when not a git repo / git missing.
 *
 * Same describe install.ts stamps the mirror with: the release tag on a tagged HEAD
 * (stable), else a short SHA (edge). Used only for the before/after report, so any
 * failure degrades to "" rather than aborting the update.
 */
export async function describeVersion(repoRoot: string): Promise<string> {
    try {
        const r = await reap(Bun.spawn(["git", "-C", repoRoot, "describe", "--tags", "--always"], PIPED), 10_000)
        return r.exitCode === 0 ? r.stdout.trim() : ""
    } catch {
        return ""
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
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional bash positional-param expansion, not a JS template
    const script = 'set -o pipefail; curl -fsSL "$1" | bash -s -- "${@:2}"'
    return ["bash", "-c", script, "bash", url, ...forward]
}

export async function main(argv: string[], repoRoot: string): Promise<number> {
    const args = parseUpdateArgs(argv)

    // ~/.preemdeck must be the git checkout boot.sh fetches into. If it isn't, preemdeck
    // wasn't installed via boot.sh and a re-fetch + reset --hard has nothing to act on.
    if (!existsSync(join(repoRoot, ".git"))) {
        process.stderr.write(
            `${repoRoot} is not a git checkout — preemdeck wasn't installed via boot.sh, nothing to update.\n` +
                `Install it first:\n  curl -fsSL ${BOOT_URL} | bash\n`
        )
        return 1
    }

    const before = await describeVersion(repoRoot)
    console.log(`preemdeck update — current ${before || "unknown"}`)
    console.log("  pulling latest + re-slotting via boot.sh…")
    console.log()

    // Forward the channel this install tracks (preemdeck.json) so boot.sh re-fetches the
    // SAME stream instead of its stable default. An explicit PREEMDECK_CHANNEL still wins —
    // that's how you switch channels; with neither set, boot.sh falls back to stable.
    const channel = process.env.PREEMDECK_CHANNEL || readChannel(repoRoot)

    // Stream boot.sh live (inherit stdio) so the operator sees install.ts's banner/phases
    // as they happen. We're already in memory, so boot.sh's reset --hard of ~/.preemdeck
    // can't corrupt this running script (see the file docblock).
    const child = Bun.spawn(bootCommand(BOOT_URL, args.harnesses), {
        stdout: "inherit",
        stderr: "inherit",
        stdin: "inherit",
        ...(channel ? { env: { ...process.env, PREEMDECK_CHANNEL: channel } } : {})
    })
    await child.exited

    console.log()
    if (child.exitCode !== 0) {
        console.log(`  ${CROSS} update failed (boot.sh exited ${child.exitCode}) — see output above.`)
        return child.exitCode ?? 1
    }

    const after = await describeVersion(repoRoot)
    if (before && after && before !== after) {
        console.log(`  ${CHECK} updated ${before} → ${after}`)
    } else if (after) {
        console.log(`  ${CHECK} already current at ${after}`)
    } else {
        console.log(`  ${CHECK} update complete`)
    }
    console.log("  restart your CLI to load the refreshed rig.")
    return 0
}
