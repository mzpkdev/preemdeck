/**
 * tab-pids.ts — resolve the process ids living on THIS terminal tab's tty.
 *
 * The shell-side half of `rename-tab`: figure out which OS processes belong to
 * the tab this CLI is running in, so the Groovy half can match the one IDE
 * terminal Content whose backend process is one of them (pids are globally
 * unique, so the match is exact — see core/tab.ts).
 *
 * Two routes, picked by whether we sit inside tmux:
 *
 * - tmux (`$TMUX` set): the tab's login shell is the tmux client's parent, and
 *   several WebStorm tabs can mirror ONE tmux session (each attaches its own
 *   client). So target EVERY client tty attached to our session
 *   (`tmux list-clients -t <session>`), not just one — every mirroring tab
 *   should get renamed together.
 * - no tmux: the tab is a plain login shell, so target this process's own
 *   controlling tty.
 *
 * For each target tty, `ps -t <bareTty> -o pid=` lists the pids on it (the login
 * shell + any tmux client + this CLI). Their union is returned; an empty result
 * makes the CLI rename nothing (never guess).
 */

/**
 * Run `argv` and resolve its stdout; resolve to `""` on ANY failure (spawn
 * error, non-tmux `tmux` call, missing binary). Injectable so tests can feed
 * canned `tmux`/`ps` output without spawning subprocesses.
 */
export type RunText = (argv: string[]) => Promise<string>

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

/**
 * The set of ttys whose processes belong to this tab.
 *
 * In tmux: the client ttys attached to our session — possibly several, when
 * multiple WebStorm tabs mirror the same session. Outside tmux: this process's
 * own controlling tty. Either probe degrading to empty (`run` returns `""`,
 * `ps` reports no tty as `??`) yields no targets, so the caller renames nothing.
 */
const targetTtys = async (run: RunText): Promise<string[]> => {
    if (process.env.TMUX) {
        const session = (await run(["tmux", "display-message", "-p", "#{session_name}"])).trim()
        if (session.length === 0) {
            return []
        }
        const out = await run(["tmux", "list-clients", "-t", session, "-F", "#{client_tty}"])
        return out
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
    }
    // Not tmux: this CLI's own controlling tty (macOS reports "no tty" as "??").
    const own = (await run(["ps", "-o", "tty=", "-p", String(process.pid)])).trim()
    return own.length > 0 && own !== "??" ? [own] : []
}

/**
 * The pids sharing this tab's tty (the login shell, plus any tmux client and
 * this CLI itself), deduped and returned as positive integers.
 *
 * The Groovy half (`groovyRenameByPid`) renames only the IDE terminal Content
 * whose backend process pid is in this set, so a precise set means a precise
 * rename. An empty result (not in a terminal, no attached client, or a failed
 * probe) makes the CLI a no-op — it renames nothing rather than guessing.
 *
 * `run` is an injectable seam for hermetic tests; production spawns real
 * `tmux`/`ps`.
 */
export const resolveTabPids = async (run: RunText = defaultRunText): Promise<number[]> => {
    const ttys = await targetTtys(run)
    const pids = new Set<number>()
    for (const tty of ttys) {
        const bare = bareTty(tty)
        if (bare.length === 0) {
            continue
        }
        const out = await run(["ps", "-t", bare, "-o", "pid="])
        for (const line of out.split("\n")) {
            const pid = Number.parseInt(line.trim(), 10)
            if (Number.isInteger(pid) && pid > 0) {
                pids.add(pid)
            }
        }
    }
    return [...pids]
}

/**
 * A STABLE identifier for the tab this shell runs in — the key under which a
 * chosen tab name is persisted (see core/tab-names.ts). Not the pid set: pids
 * turn over every process, so they can't key a name that must outlive them.
 *
 * - tmux (`$TMUX` set): the tmux session name (`display-message #{session_name}`).
 *   Several WebStorm tabs can mirror one session; they SHOULD share one saved
 *   name, so the session — not a per-client tty — is the right key.
 * - no tmux: this process's own controlling tty (`ps -o tty= -p <pid>`), the same
 *   probe {@link resolveTabPids} uses for the non-tmux tab, bare-formed. Each plain
 *   login-shell tab has its own tty, so each keys independently.
 *
 * Returns "" when neither resolves (a failed probe, or macOS's `??` "no tty") —
 * callers treat "" as "no stable key" and skip persistence rather than colliding
 * every unkeyed tab onto one shared name.
 *
 * `run` is the same injectable seam as {@link resolveTabPids} for hermetic tests.
 */
export const tabKey = async (run: RunText = defaultRunText): Promise<string> => {
    if (process.env.TMUX) {
        return (await run(["tmux", "display-message", "-p", "#{session_name}"])).trim()
    }
    const own = (await run(["ps", "-o", "tty=", "-p", String(process.pid)])).trim()
    return own.length > 0 && own !== "??" ? bareTty(own) : ""
}
