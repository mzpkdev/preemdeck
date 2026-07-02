/**
 * process.ts — composable child-process reaping with a timeout that ACTUALLY kills.
 *
 * Not a spawn wrapper: callers spawn inline with native `Bun.spawn(argv, PIPED)`
 * and hand the child to {@link reap}, which awaits exit, drains stdout/stderr to
 * text, and reports whether a timeout tripped. Composing this way keeps the spawn
 * options (cwd, env, stdin, …) in the caller's hands while the drain/timeout/kill
 * logic lives here once.
 *
 * The result is gated on PROCESS EXIT, never on pipe EOF. A descendant that
 * inherits the pipes and outlives the child (a CLI's background updater, a
 * daemonized helper) keeps the streams open indefinitely — waiting for EOF turned
 * such clean exits into false "timed out" failures (the dock-rack install bug).
 * After exit the drain gets a short grace to deliver the tail, then whatever
 * arrived is returned. On timeout the child is SIGKILLed and the call returns at
 * once with the partial output (see process.spec.ts). Never throws on a non-zero
 * exit (check `.exitCode`); a bad `Bun.spawn` argv throws at the call site,
 * before `reap` ever sees the child.
 */

/** Stock stdio config for {@link reap}: pipe both streams so they can be drained to text. */
export const PIPED = { stdout: "pipe", stderr: "pipe" } as const

/** Outcome of a {@link reap}: exit code, captured stdout/stderr, and whether the timeout killed it. */
export type Reaped = {
    /** Process exit code, or null when the child was killed by a signal. */
    exitCode: number | null
    /** Captured stdout (UTF-8) — partial if the timeout or the post-exit grace cut the drain short. */
    stdout: string
    /** Captured stderr (UTF-8) — partial if the timeout or the post-exit grace cut the drain short. */
    stderr: string
    /** True when `timeoutMs` elapsed before the child exited and it was killed. */
    timedOut: boolean
}

// After the child exits, how long to keep reading pipes that a lingering
// descendant may hold open. Children with no such descendant close their pipes
// at exit, so the race below settles immediately and this never adds latency.
const PIPE_GRACE_MS = 150

/**
 * Await a piped child and drain its output, returning its {@link Reaped} outcome.
 *
 * Pair with `Bun.spawn(argv, PIPED)` (or `{ ...PIPED, cwd, env, … }`). The child's
 * EXIT decides the outcome: once it exits, the pipes get {@link PIPE_GRACE_MS} to
 * close (they stay open while any descendant that inherited them lives), then the
 * output captured so far is returned with `timedOut: false`. On timeout the child
 * is sent `killSignal` (SIGKILL by default) and the call returns at once with the
 * partial output — it never blocks on a drain a SIGTERM-ignoring child or a
 * pipe-holding descendant could hold open forever. A timer that fires after the
 * child already exited is a no-op: that run finished, so it reports success.
 * Omit/0 `timeoutMs` = no timeout. Never throws on a non-zero exit; the caller
 * decides what an exit code or a timeout means.
 */
export const reap = async (
    child: Bun.Subprocess,
    timeoutMs = 0,
    killSignal: NodeJS.Signals | number = "SIGKILL"
): Promise<Reaped> => {
    const captured = { stdout: "", stderr: "" }
    const readers: PipeReader[] = []
    const drains = Promise.all([
        drainInto(child.stdout, readers, (text) => {
            captured.stdout += text
        }),
        drainInto(child.stderr, readers, (text) => {
            captured.stderr += text
        })
    ])

    // Success path: exit first, then a grace-bounded wait for the pipe tail.
    // Pipe EOF is NOT required — a descendant holding the write end forfeits
    // only its own late output, never the child's exit status.
    const settled: Promise<Reaped> = (async () => {
        await child.exited
        await Promise.race([drains, Bun.sleep(PIPE_GRACE_MS)])
        return { exitCode: child.exitCode, stdout: captured.stdout, stderr: captured.stderr, timedOut: false }
    })()

    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<Reaped>((resolve) => {
        if (timeoutMs <= 0) {
            return
        }
        timer = setTimeout(() => {
            // Already exited -> the run finished in time; let `settled` win (it
            // resolves within the grace). Otherwise SIGKILL — it can't be caught
            // or ignored — and resolve at once with whatever output arrived.
            if (child.exitCode !== null || child.signalCode !== null) {
                return
            }
            try {
                child.kill(killSignal)
            } catch {
                // exited between the check and the kill
            }
            resolve({ exitCode: child.exitCode, stdout: captured.stdout, stderr: captured.stderr, timedOut: true })
        }, timeoutMs)
    })

    try {
        return await Promise.race([settled, expired])
    } finally {
        clearTimeout(timer)
        // Release the pipe readers so an abandoned drain can't hold FDs (or the
        // event loop) hostage to a lingering descendant. cancel() resolves any
        // pending read with done: true, ending drainInto cleanly.
        for (const reader of readers) {
            void reader.cancel().catch(() => {})
        }
    }
}

// What reap needs back from a drain to release it later. Structural on purpose:
// Bun's global ReadableStreamDefaultReader and node:stream/web's disagree on
// extras (readMany), and cancel() is all the cleanup path uses.
type PipeReader = { cancel: (reason?: unknown) => Promise<void> }

/**
 * Incrementally drain a piped child stream, handing each decoded chunk to `write`
 * so partial output survives a timeout or grace cutoff. Stream errors (e.g. the
 * child dying to SIGKILL mid-read) end the drain, keeping what already arrived.
 */
const drainInto = async (
    stream: ReadableStream | number | undefined,
    readers: PipeReader[],
    write: (text: string) => void
): Promise<void> => {
    if (!stream || typeof stream === "number") {
        return
    }
    const reader = (stream as ReadableStream<Uint8Array>).getReader()
    readers.push(reader)
    const decoder = new TextDecoder()
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) {
                break
            }
            write(decoder.decode(value, { stream: true }))
        }
        write(decoder.decode())
    } catch {
        // errored mid-read — keep the partial text
    }
}
