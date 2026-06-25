/**
 * reap.ts — deferred temp-file cleanup for the toolbox's fire-and-forget
 * (no-wait) modes. Port of core/_reap.py.
 *
 * No-wait callers spawn the IDE async and have no signal for when the handed-off
 * temp is safe to delete. But the IDE reads the file into memory within ~1s of
 * launch, after which the on-disk copy can be unlinked and the editor keeps
 * working (it shows a dismissible "deleted from disk" marker). So instead of
 * leaking the temp, schedule an unlink a short delay after launch.
 *
 * The Python original spawns a NON-DAEMON thread: the interpreter waits for it
 * at process exit, so cleanup is guaranteed rather than killed. The faithful JS
 * analog is a plain (REF'd) `setTimeout` — a pending ref'd timer keeps Bun's
 * event loop alive, so the process stays up until the unlink runs. Do NOT
 * `.unref()` it, and do NOT `process.exit()` for this fire-and-forget cleanup
 * (the contract settled this) — either would drop the pending reap.
 */

import { unlink } from "node:fs/promises"

/**
 * Default delay before the deferred unlink fires. ~3s gives the IDE ample
 * margin over its ~1s read window to pull the handed-off temp into memory
 * before the on-disk copy is reaped. Override via PREEMDECK_REAP_DELAY_MS
 * (e.g. "0" in tests to reap immediately); falls back to 3000 when unset/invalid.
 */
const envDelay = Number(process.env.PREEMDECK_REAP_DELAY_MS)
export const REAP_DELAY_MS = Number.isFinite(envDelay) ? envDelay : 3000

/**
 * Schedule `paths` to be unlinked `delayMs` ms from now; return at once.
 *
 * Arms a ref'd `setTimeout` that unlinks each path, swallowing any error (a
 * missing file or any FS error is ignored — the reaper never rejects). Returns
 * IMMEDIATELY without awaiting, so fire-and-forget callers stay non-blocking;
 * the pending timer keeps the event loop alive until the unlink runs, so a
 * short-lived CLI's cleanup is guaranteed rather than killed on exit.
 *
 * `paths` is any iterable of strings; an empty iterable is fine (the timer just
 * fires and unlinks nothing). It is materialized up front so a transient
 * caller-owned generator can't be exhausted before the timer fires.
 */
export const reapLater = (paths: Iterable<string>, delayMs: number = REAP_DELAY_MS): void => {
    const targets = [...paths]
    setTimeout(() => {
        void reap(targets)
    }, delayMs)
}

/** Unlink every target, swallowing per-path errors (never rejects). */
const reap = async (targets: string[]): Promise<void> => {
    for (const path of targets) {
        try {
            await unlink(path)
        } catch {
            // never raise from the reaper (matches missing_ok=True + suppress(OSError))
        }
    }
}
