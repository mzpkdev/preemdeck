/**
 * launch.ts — launch the running JetBrains IDE (cross-platform), optionally
 * blocking. Port of core/_launch.py.
 *
 * Resolve the IDE binary and spawn it. With `wait: false` (default) the launch
 * is fire-and-forget; with `wait: true` the IDE's native `--wait` is appended
 * and the call blocks on the child's exit until the opened tab/window closes.
 *
 * Stdio is INHERITED (like Python's `subprocess.Popen`, which inherits the
 * parent fds by default) so the launcher attaches to the caller's terminal
 * rather than having its output captured/swallowed.
 */

import { resolveExecPath as resolveForPlatform } from "./index.ts"

/** The spawn primitive, injectable for hermetic tests (default: Bun.spawn). */
export type Spawn = (argv: string[]) => Bun.Subprocess

const defaultSpawn: Spawn = (argv) =>
    Bun.spawn(argv, {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit"
    })

/**
 * Knobs for {@link launch}: how to block (`wait`) and the injectable seams
 * (`resolveExec`, `spawn`) tests use to drive it without a real IDE or process.
 */
export type LaunchOptions = {
    /**
     * `false` (default): fire-and-forget — resolves as soon as the child is
     * spawned, without joining (no native `--wait`). `true`: append the IDE's
     * native `--wait` flag at the END of the arg vector and block on the child's
     * exit, returning once the IDE tab/window CLOSES (whether or not it was
     * edited).
     */
    wait?: boolean
    /**
     * IDE-binary resolver, injectable for tests. Default: the platform's
     * (now-async) resolveExecPath. Accepts a sync OR async resolver; it is awaited.
     */
    resolveExec?: () => string | Promise<string>
    /** Spawn primitive, injectable for tests. Default: Bun.spawn with inherited stdio. */
    spawn?: Spawn
}

/**
 * Spawn the running JetBrains IDE with `args`; resolve to the child handle.
 *
 * resolveExecPath() is the single guard: it throws IdeaError when no JetBrains
 * IDE is in the ancestry, and that propagates (callers turn it into a CLI exit
 * 1). No second inIdea() check.
 *
 * Returns a Promise: with `wait: true` it resolves only after the child exits
 * (blocking, like Python `.wait()`); with `wait: false` it resolves as soon as
 * the child is spawned, leaving it running.
 */
export const launch = async (args: string[], options: LaunchOptions = {}): Promise<Bun.Subprocess> => {
    const wait = options.wait ?? false
    const resolveExec = options.resolveExec ?? resolveForPlatform
    const spawn = options.spawn ?? defaultSpawn

    const execPath = await resolveExec()
    const argv = wait ? [execPath, ...args, "--wait"] : [execPath, ...args]
    const child = spawn(argv)
    if (wait) {
        await child.exited
    }
    return child
}
