/**
 * process.ts — composable child-process reaping with a timeout that ACTUALLY kills.
 *
 * Not a spawn wrapper: callers spawn inline with native `Bun.spawn(argv, PIPED)`
 * and hand the child to {@link reap}, which drains stdout/stderr to text, awaits
 * exit, and reports whether a timeout tripped. Composing this way keeps the spawn
 * options (cwd, env, stdin, …) in the caller's hands while the drain/timeout/kill
 * logic lives here once.
 *
 * On timeout it SIGKILLs the child and returns promptly by RACING the kill against
 * the drain — a child that ignores SIGTERM, or a descendant holding the pipe open,
 * can no longer wedge the call (see process.spec.ts). Never throws on
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
 * fully-finished process. On timeout the child is sent `killSignal` (SIGKILL by
 * default) and the call returns at once — it does NOT block on the drain, which a
 * SIGTERM-ignoring child or a pipe-holding descendant could hold open forever; the
 * caller just sees `timedOut: true`. Omit/0 `timeoutMs` = no timeout. Never throws on a
 * non-zero exit; the caller decides what an exit code or a timeout means.
 */
export const reap = async (
    child: Bun.Subprocess,
    timeoutMs = 0,
    killSignal: NodeJS.Signals | number = "SIGKILL"
): Promise<Reaped> => {
    // drain awaits stdout/stderr to CLOSE, which happens only once every write-end
    // is gone — the child AND any descendant that inherited the pipe. A child that
    // ignores SIGTERM (or a grandchild holding the pipe) keeps it open forever, so
    // the timeout must win by RACING the kill, never by awaiting the drain.
    const drained: Promise<Reaped> = (async () => {
        const [stdout, stderr] = await Promise.all([drain(child.stdout), drain(child.stderr)])
        await child.exited
        return { exitCode: child.exitCode, stdout, stderr, timedOut: false }
    })()

    if (timeoutMs <= 0) {
        return drained
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<Reaped>((resolve) => {
        timer = setTimeout(() => {
            // SIGKILL can't be caught or ignored, so the child dies even if it traps
            // SIGTERM; resolve at once rather than wait on a drain a surviving
            // descendant could hold open.
            try {
                child.kill(killSignal)
            } catch {
                // already exited
            }
            resolve({ exitCode: child.exitCode, stdout: "", stderr: "", timedOut: true })
        }, timeoutMs)
    })

    try {
        return await Promise.race([drained, expired])
    } finally {
        clearTimeout(timer)
        // If the timeout won, `drained` is abandoned — swallow any late rejection
        // (e.g. the stream erroring after the kill) so it can't surface unhandled.
        void drained.catch(() => {})
    }
}

/** Drain a piped child stream fully to text. */
const drain = (stream: ReadableStream | number | undefined): Promise<string> =>
    new Response(stream as ReadableStream).text()
