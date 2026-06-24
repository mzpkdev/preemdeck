/**
 * lib/proc.ts — child-process spawn with a timeout that ACTUALLY kills the child.
 *
 * Resolves the install fixer's open question: a `timeoutMs` that fires must
 * terminate the child, not just reject the promise while the process leaks.
 * See proc.test.ts: `sleep 5` under a 200ms timeout is killed and reaped.
 *
 * Thin wrapper over `Bun.spawn`. Captures stdout/stderr as text, returns the
 * exit code, and reports whether the timeout tripped. Never throws on a non-zero
 * exit (check `.exitCode`); only invalid spawn args reject.
 */

/** Knobs for {@link spawn}: timeout-with-kill, cwd, env overlay, stdin, kill signal — all optional. */
export type SpawnOptions = {
  /** Kill the child and resolve with `timedOut: true` after this many ms. Omit/0 = no timeout. */
  timeoutMs?: number
  /** Working directory for the child. */
  cwd?: string
  /** Extra environment for the child (merged over the parent env by Bun.spawn). */
  env?: Record<string, string | undefined>
  /** Optional stdin payload written to the child, then closed. */
  stdin?: string
  /** Signal used to kill on timeout. Default "SIGTERM". */
  killSignal?: NodeJS.Signals | number
}

/** Outcome of a {@link spawn}: exit code, captured stdout/stderr, and whether the timeout killed it. */
export type SpawnResult = {
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
 * Spawn `cmd` (argv array; cmd[0] is the executable) and await completion.
 *
 * On timeout the child is sent `killSignal` (SIGTERM by default), the promise
 * resolves with `timedOut: true`, and the process is awaited so it's reaped — no
 * leak. Callers decide what a timeout means for them.
 */
export const spawn = async (cmd: string[], options: SpawnOptions = {}): Promise<SpawnResult> => {
  if (cmd.length === 0) {
    throw new Error("spawn: cmd must be a non-empty argv array")
  }
  const killSignal = options.killSignal ?? "SIGTERM"

  const child = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    stdin: options.stdin != null ? new TextEncoder().encode(options.stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  })

  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  if (options.timeoutMs && options.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      // kill() then await child.exited below guarantees the child is reaped, not leaked.
      child.kill(killSignal)
    }, options.timeoutMs)
  }

  try {
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    await child.exited
    return { exitCode: child.exitCode, stdout, stderr, timedOut }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
