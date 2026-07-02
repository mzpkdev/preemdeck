/**
 * deps.ts — install preemdeck's runtime deps as an install phase.
 */

import { PIPED, type Reaped, reap } from "../common/process"

/**
 * Install preemdeck's runtime deps (hono, zod, cmdore, …) into node_modules so deployed
 * plugin code can execute from ~/.preemdeck by absolute path. Runs `<bun> install
 * --production` on the SAME Bun executing install.ts (process.execPath — the vendored
 * runtime under preemdeck-runtime), in repoRoot.
 *
 * Relocated from boot.sh so it renders as an install phase under the banner. Best-effort by
 * contract: a failure is REPORTED but never aborts the install (node_modules is gitignored —
 * a fresh clone has none until this runs; a stale clone keeps its last good set). Skips the
 * spawn on a dry run.
 */
export async function installDeps(repoRoot: string, dryRun: boolean): Promise<[boolean, string]> {
    if (dryRun) {
        return [true, ""]
    }
    let result: Reaped
    try {
        result = await reap(
            Bun.spawn([process.execPath, "install", "--production"], { ...PIPED, cwd: repoRoot }),
            300_000
        )
    } catch (err) {
        return [false, err instanceof Error ? err.message : String(err)]
    }
    if (result.timedOut) {
        return [false, "timed out after 300s"]
    }
    if (result.exitCode === 0) {
        return [true, ""]
    }
    return [false, result.stderr.trim() || result.stdout.trim() || "non-zero exit"]
}
