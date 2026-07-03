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
 * - no tmux: the tab is a plain login shell. Target the controlling tty of the
 *   nearest ancestor that has one — our own when a human runs the CLI in the tab,
 *   or an ancestor's (the `claude`/agent process, or the login shell JediTerm
 *   spawned) when an agent runs it in a ttyless child. See {@link ownTabTty}.
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
    // Not tmux: the tab's tty is the nearest ancestor's controlling tty — our own
    // when a human runs the CLI in the tab, or an ancestor's (claude / the login
    // shell) when an agent runs it in a ttyless child. See ownTabTty.
    const own = await ownTabTty(run)
    return own.length > 0 ? [own] : []
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
