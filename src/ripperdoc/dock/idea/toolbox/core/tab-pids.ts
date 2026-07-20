/**
 * tab-pids.ts — resolve the identities of THIS terminal tab.
 *
 * A JetBrains terminal session id survives PID namespaces, while host-visible
 * process ids preserve the established direct-shell fallback. Returning both
 * lets the Groovy half match one terminal Content without guessing.
 *
 * Two routes, picked by whether we sit inside tmux:
 *
 * - tmux (`$TMUX` set): ask the host tmux server for every attached client pid.
 *   This crosses a sandbox PID namespace without running `ps`, and preserves
 *   mirrored tabs by returning every client attached to the current session.
 * - no tmux: the tab is a plain login shell. Target the controlling tty of the
 *   nearest ancestor that has one — our own when a human runs the CLI in the tab,
 *   or an ancestor's (the `claude`/agent process, or the login shell JediTerm
 *   spawned) when an agent runs it in a ttyless child. See {@link ownTabTty}.
 *
 * Outside tmux, `ps -t <bareTty> -o pid=` lists the pids on the resolved tty.
 * An empty identity set makes callers touch no tab.
 */

/**
 * Run `argv` and resolve its stdout; resolve to `""` on ANY failure (spawn
 * error, non-tmux `tmux` call, missing binary). Injectable so tests can feed
 * canned `tmux`/`ps` output without spawning subprocesses.
 */
export type RunText = (argv: string[]) => Promise<string>

/** Exact identities that can select one JetBrains terminal tab. */
export type TabTargets = { pids: number[]; termSessionIds: string[] }

/** Lift the legacy pid-only input into the shared target contract and copy both arrays. */
export const normalizeTabTargets = (value: readonly number[] | TabTargets): TabTargets => {
    if ("pids" in value) {
        return { pids: [...value.pids], termSessionIds: [...value.termSessionIds] }
    }
    return { pids: [...value], termSessionIds: [] }
}

const defaultRunText: RunText = async (argv) => {
    try {
        const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" })
        const out = await new Response(proc.stdout).text()
        await proc.exited
        return out
    } catch {
        return ""
    }
}

/** Strip a leading `/dev/` so the tty is in the bare form `ps -t` expects (`ttys006`). */
const bareTty = (tty: string): string => tty.trim().replace(/^\/dev\//, "")

/** True when a `ps -o tty=` value denotes NO controlling tty: macOS `??`, Linux `?`, or empty. */
const noTty = (tty: string): boolean => tty.length === 0 || tty === "??" || tty === "?"

/**
 * This tab's controlling tty: the tty of the nearest ancestor that HAS one,
 * bare-formed (no `/dev/`), or "" when none resolves.
 *
 * When the CLI runs directly in the tab's interactive shell, that shell's own tty
 * IS the tab's tty — resolved on the first hop. But when an AGENT (Claude Code,
 * etc.) runs it, the command lands in a detached child with NO controlling tty
 * (macOS reports `??`, Linux `?`), while the tab's tty still belongs to an
 * ancestor: the `claude`/agent process and the login shell JediTerm spawned both
 * sit on it. So walk the PPID chain from this process up and return the FIRST real
 * tty found — that is our tab's tty either way, and the pids on it still include
 * the login shell that backs the IDE terminal Content, so the Groovy match stays
 * exact.
 *
 * Bounded so a probe miss or a cycle can't loop: a hop cap plus a stop on an
 * absent probe line or a `ppid <= 1` / non-integer parent. A fully headless run
 * (no ancestor has a tty) yields "". Uses the same `ps -o ppid=,tty=` shape as
 * idea-mac's ancestry probe (VERIFIED under the pinned Bun); `run` is the shared
 * injectable seam for hermetic tests.
 */
const ownTabTty = async (run: RunText): Promise<string> => {
    let pid = process.pid
    for (let hops = 0; hops < 40 && pid > 1; hops++) {
        const line = (await run(["ps", "-o", "ppid=,tty=", "-p", String(pid)])).trim()
        if (line.length === 0) {
            return ""
        }
        const [ppidRaw, ttyRaw = ""] = line.split(/\s+/)
        const tty = ttyRaw.trim()
        if (!noTty(tty)) {
            return bareTty(tty)
        }
        const ppid = Number.parseInt(ppidRaw ?? "", 10)
        if (!Number.isInteger(ppid) || ppid <= 1) {
            return ""
        }
        pid = ppid
    }
    return ""
}

/**
 * Resolve the current tab's namespace-safe session id and host-visible pids.
 * In tmux the pids come directly from `list-clients`; outside tmux they come
 * from the nearest ancestor tty. Invalid values are ignored and identities are
 * deduped. Any failed probe degrades to the identities already proven.
 */
export const resolveTabTargets = async (
    run: RunText = defaultRunText,
    env: NodeJS.ProcessEnv = process.env
): Promise<TabTargets> => {
    const pids = new Set<number>()
    const termSessionIds = new Set<string>()
    const termSessionId = env.TERM_SESSION_ID?.trim()
    if (termSessionId) {
        termSessionIds.add(termSessionId)
    }

    let output = ""
    if (env.TMUX) {
        const session = (await run(["tmux", "display-message", "-p", "#{session_name}"])).trim()
        if (session) {
            output = await run(["tmux", "list-clients", "-t", session, "-F", "#{client_pid}"])
        }
    } else {
        const tty = await ownTabTty(run)
        if (tty) {
            output = await run(["ps", "-t", bareTty(tty), "-o", "pid="])
        }
    }

    for (const line of output.split("\n")) {
        const pid = Number.parseInt(line.trim(), 10)
        if (Number.isInteger(pid) && pid > 0) {
            pids.add(pid)
        }
    }

    return { pids: [...pids], termSessionIds: [...termSessionIds] }
}

/** Legacy pid-only wrapper retained for existing callers and external imports. */
export const resolveTabPids = async (run: RunText = defaultRunText): Promise<number[]> =>
    (await resolveTabTargets(run)).pids
