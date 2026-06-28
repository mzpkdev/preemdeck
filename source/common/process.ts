/**
 * process.ts — composable child-process reaping with a timeout that ACTUALLY kills.
 *
 * Not a spawn wrapper: callers spawn inline with native `Bun.spawn(argv, PIPED)`
 * and hand the child to {@link reap}, which drains stdout/stderr to text, awaits
 * exit, and reports whether a timeout tripped. Composing this way keeps the spawn
 * options (cwd, env, stdin, …) in the caller's hands while the drain/timeout/kill
 * logic lives here once.
 *
 * The timeout doesn't just resolve early — it sends `killSignal` AND awaits the
 * child's exit, so a killed process is reaped, never leaked (see process.spec.ts:
 * `sleep 5` under a 200ms timeout is killed and returns promptly). Never throws on
 * a non-zero exit (check `.exitCode`); a bad `Bun.spawn` argv throws at the call
 * site, before `reap` ever sees the child.
 */

/** Stock stdio config for {@link reap}: pipe both streams so they can be drained to text. */
export const PIPED = { stdout: "pipe", stderr: "pipe" } as const

/** Outcome of a {@link reap}: exit code, captured stdout/stderr, and whether the timeout killed it. */
export type Reaped = {
    /** Process exit code, or null when the child was killed by a signal. */
    exitCode: number | null
    /** Captured stdout (UTF-8). */
    stdout: string
    /** Captured stderr (UTF-8). */
    stderr: string
    /** True when `timeoutMs` elapsed and the child was killed. */
    timedOut: boolean
}

/**
 * Drain and await a piped child, returning its {@link Reaped} outcome.
 *
 * Pair with `Bun.spawn(argv, PIPED)` (or `{ ...PIPED, cwd, env, … }`). stdout and
 * stderr are read to text; then `child.exited` is awaited so the result reflects a
 * fully-finished process. On timeout the child is sent `killSignal` (SIGTERM by
 * default) and STILL awaited below, so it's reaped rather than leaked — the caller
 * just sees `timedOut: true`. Omit/0 `timeoutMs` = no timeout. Never throws on a
 * non-zero exit; the caller decides what an exit code or a timeout means.
 */
export const reap = async (
    child: Bun.Subprocess,
    timeoutMs = 0,
    killSignal: NodeJS.Signals | number = "SIGTERM"
): Promise<Reaped> => {
    let timedOut = false
    const timer =
        timeoutMs > 0
            ? setTimeout(() => {
                  timedOut = true
                  child.kill(killSignal)
              }, timeoutMs)
            : undefined
    try {
        const [stdout, stderr] = await Promise.all([drain(child.stdout), drain(child.stderr)])
        await child.exited
        return { exitCode: child.exitCode, stdout, stderr, timedOut }
    } finally {
        clearTimeout(timer)
    }
}

/** Drain a piped child stream fully to text. */
const drain = (stream: ReadableStream | number | undefined): Promise<string> =>
    new Response(stream as ReadableStream).text()
