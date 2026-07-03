/**
 * tab-pids.spec.ts — the shell-side pid resolver + stable tab key, driven through
 * an injected RunText seam (no real tmux/ps spawns, save one defensive real-seam
 * smoke).
 *
 * tmux path ($TMUX set): union the pids across EVERY `#{client_tty}` line from
 * list-clients; an empty session name short-circuits to []. Non-tmux path: the
 * nearest ANCESTOR tty — ownTabTty walks the `ps -o ppid=,tty=` PPID chain from
 * this process up and returns the first real tty, so an agent's ttyless child
 * still resolves the tab's tty through its `claude`/login-shell ancestor. macOS
 * `??` / Linux `?` / empty count as "no tty" and are walked past; a `ppid <= 1`,
 * a non-integer parent, or a blank probe ends the walk at "". The walk is
 * hop-capped so a ppid cycle can't spin. bareTty strips `/dev/` before `ps -t`;
 * pids dedupe across ttys; non-numeric / blank / non-positive `ps` lines drop.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { type RunText, resolveTabPids, tabKey } from "./tab-pids"

const context = describe

const TMUX = "/tmp/tmux-501/default,1,0"
/** The pid the first ancestry hop probes (`ps -o ppid=,tty= -p <process.pid>`). */
const SELF = String(process.pid)

/** A RunText that records every argv and answers via `handler`. */
const runWith = (handler: (argv: string[]) => string): { calls: string[][]; run: RunText } => {
    const calls: string[][] = []
    return {
        calls,
        run: (argv) => {
            calls.push(argv)
            return Promise.resolve(handler(argv))
        }
    }
}

const asc = (nums: number[]): number[] => [...nums].sort((a, b) => a - b)

/** True for an ancestry probe (`ps -o ppid=,tty= -p <pid>`). */
const isAncestryProbe = (argv: string[]): boolean => argv[1] === "-o" && argv[2] === "ppid=,tty="

describe("resolveTabPids", () => {
    const savedTmux = process.env.TMUX
    afterEach(() => {
        if (savedTmux === undefined) delete process.env.TMUX
        else process.env.TMUX = savedTmux
    })

    context("inside tmux ($TMUX set)", () => {
        it("unions the pids over every client tty attached to the session", async () => {
            process.env.TMUX = TMUX
            const f = runWith((argv) => {
                if (argv[1] === "display-message") return "work\n"
                if (argv[1] === "list-clients") return "/dev/ttys002\n/dev/ttys005\n"
                if (argv[1] === "-t" && argv[2] === "ttys002") return "111\n222\n"
                if (argv[1] === "-t" && argv[2] === "ttys005") return "222\n333\n"
                return ""
            })
            const pids = await resolveTabPids(f.run)
            expect(asc(pids)).toEqual([111, 222, 333])
            expect(pids.length).toBe(3) // 222 lived on both ttys, deduped
            // bareTty stripped the leading /dev/ before ps -t
            expect(f.calls).toContainEqual(["ps", "-t", "ttys002", "-o", "pid="])
            expect(f.calls).toContainEqual(["ps", "-t", "ttys005", "-o", "pid="])
        })

        it("is [] on an empty/blank session name and never queries clients", async () => {
            process.env.TMUX = TMUX
            const f = runWith((argv) => (argv[1] === "display-message" ? "  \n" : "SHOULD-NOT-RUN"))
            expect(await resolveTabPids(f.run)).toEqual([])
            expect(f.calls.every((c) => c[1] !== "list-clients")).toBe(true)
        })

        it("is [] when a resolved client tty has no pids", async () => {
            process.env.TMUX = TMUX
            const f = runWith((argv) => {
                if (argv[1] === "display-message") return "work"
                if (argv[1] === "list-clients") return "/dev/ttys002\n"
                return "" // ps -t yields nothing
            })
            expect(await resolveTabPids(f.run)).toEqual([])
        })
    })

    context("outside tmux ($TMUX unset)", () => {
        it("resolves the own tty on the first hop when the CLI runs in the tab shell", async () => {
            delete process.env.TMUX
            const f = runWith((argv) => {
                if (isAncestryProbe(argv)) return argv[4] === SELF ? "1234 ttys006\n" : ""
                if (argv[1] === "-t" && argv[2] === "ttys006") return "500\n501\n"
                return ""
            })
            expect(asc(await resolveTabPids(f.run))).toEqual([500, 501])
            expect(f.calls).toContainEqual(["ps", "-t", "ttys006", "-o", "pid="])
            // own tty was real, so the walk stops after ONE ancestry probe
            expect(f.calls.filter(isAncestryProbe).length).toBe(1)
        })

        it("walks the PPID chain to an ancestor's tty when our own is ttyless (agent-run)", async () => {
            delete process.env.TMUX
            // our detached child has no tty (??); the claude/login-shell ancestor holds the tab tty
            const anc: Record<string, string> = { [SELF]: "80108 ??\n", "80108": "77290 ttys013\n" }
            const f = runWith((argv) => {
                if (isAncestryProbe(argv)) return anc[argv[4] ?? ""] ?? ""
                if (argv[1] === "-t" && argv[2] === "ttys013") return "77290\n80108\n"
                return ""
            })
            expect(asc(await resolveTabPids(f.run))).toEqual([77290, 80108])
            expect(f.calls).toContainEqual(["ps", "-t", "ttys013", "-o", "pid="])
            expect(f.calls.filter(isAncestryProbe).length).toBe(2) // self (??), then the ancestor
        })

        it("treats a Linux `?` no-tty like `??` and keeps walking", async () => {
            delete process.env.TMUX
            const anc: Record<string, string> = { [SELF]: "4242 ?\n", "4242": "4243 pts/3\n" }
            const f = runWith((argv) => {
                if (isAncestryProbe(argv)) return anc[argv[4] ?? ""] ?? ""
                if (argv[1] === "-t" && argv[2] === "pts/3") return "900\n"
                return ""
            })
            expect(await resolveTabPids(f.run)).toEqual([900])
        })

        it("is [] when no ancestor has a tty (headless), and never runs ps -t", async () => {
            delete process.env.TMUX
            // the chain ends at init (ppid 1) with no tty
            const f = runWith((argv) => (isAncestryProbe(argv) && argv[4] === SELF ? "1 ??\n" : "SHOULD-NOT-RUN"))
            expect(await resolveTabPids(f.run)).toEqual([])
            expect(f.calls.every((c) => c[1] !== "-t")).toBe(true)
        })

        it("is bounded on a ppid cycle: hop-caps the walk and returns []", async () => {
            delete process.env.TMUX
            // every probe reports a ttyless process whose parent never reaches init
            const f = runWith((argv) => (isAncestryProbe(argv) ? "999 ??\n" : "SHOULD-NOT-RUN"))
            expect(await resolveTabPids(f.run)).toEqual([])
            expect(f.calls.filter(isAncestryProbe).length).toBe(40) // the hop cap, not an infinite spin
        })

        it("bareTty strips a leading /dev/ from an ancestor tty", async () => {
            delete process.env.TMUX
            const f = runWith((argv) => {
                if (isAncestryProbe(argv)) return argv[4] === SELF ? "1234 /dev/ttys009\n" : ""
                if (argv[1] === "-t") return "700\n"
                return ""
            })
            await resolveTabPids(f.run)
            expect(f.calls).toContainEqual(["ps", "-t", "ttys009", "-o", "pid="])
        })
    })

    context("parsing the ps pid lines", () => {
        it("ignores blank, non-numeric, zero, and negative lines", async () => {
            delete process.env.TMUX
            const f = runWith((argv) => {
                if (isAncestryProbe(argv)) return argv[4] === SELF ? "1234 ttys010\n" : ""
                if (argv[1] === "-t") return "111\n\n   \nabc\n0\n-5\n222\n"
                return ""
            })
            expect(asc(await resolveTabPids(f.run))).toEqual([111, 222])
        })
    })

    context('any probe degrading to "" yields no targets', () => {
        it('is [] in tmux when every probe returns ""', async () => {
            process.env.TMUX = TMUX
            expect(await resolveTabPids(async () => "")).toEqual([])
        })

        it('is [] outside tmux when every probe returns ""', async () => {
            delete process.env.TMUX
            expect(await resolveTabPids(async () => "")).toEqual([])
        })
    })

    context("the real default seam (no injected run)", () => {
        it("resolves to an array of positive integers without throwing", async () => {
            delete process.env.TMUX
            const pids = await resolveTabPids()
            expect(Array.isArray(pids)).toBe(true)
            for (const pid of pids) {
                expect(Number.isInteger(pid)).toBe(true)
                expect(pid).toBeGreaterThan(0)
            }
        })
    })
})

describe("tabKey (the stable per-tab name key)", () => {
    const savedTmux = process.env.TMUX
    afterEach(() => {
        if (savedTmux === undefined) delete process.env.TMUX
        else process.env.TMUX = savedTmux
    })

    context("inside tmux ($TMUX set)", () => {
        it("keys on the tmux session name and never probes ps", async () => {
            process.env.TMUX = TMUX
            const f = runWith((argv) => (argv[1] === "display-message" ? "work\n" : "SHOULD-NOT-RUN"))
            expect(await tabKey(f.run)).toBe("work")
            expect(f.calls).toEqual([["tmux", "display-message", "-p", "#{session_name}"]])
        })

        it('is "" when the session name is blank', async () => {
            process.env.TMUX = TMUX
            const f = runWith(() => "  \n")
            expect(await tabKey(f.run)).toBe("")
        })
    })

    context("outside tmux ($TMUX unset)", () => {
        it("keys on the own tty resolved on the first hop", async () => {
            delete process.env.TMUX
            const f = runWith((argv) =>
                isAncestryProbe(argv) && argv[4] === SELF ? "1234 ttys006\n" : "SHOULD-NOT-RUN"
            )
            expect(await tabKey(f.run)).toBe("ttys006")
            expect(f.calls).toEqual([["ps", "-o", "ppid=,tty=", "-p", SELF]])
        })

        it("walks to an ancestor tty when our own is ttyless (agent-run)", async () => {
            delete process.env.TMUX
            const anc: Record<string, string> = { [SELF]: "80108 ??\n", "80108": "77290 ttys013\n" }
            const f = runWith((argv) => (isAncestryProbe(argv) ? (anc[argv[4] ?? ""] ?? "") : "SHOULD-NOT-RUN"))
            expect(await tabKey(f.run)).toBe("ttys013")
            expect(f.calls).toEqual([
                ["ps", "-o", "ppid=,tty=", "-p", SELF],
                ["ps", "-o", "ppid=,tty=", "-p", "80108"]
            ])
        })

        it("strips a leading /dev/ from the resolved tty", async () => {
            delete process.env.TMUX
            const f = runWith((argv) => (isAncestryProbe(argv) && argv[4] === SELF ? "1234 /dev/ttys009\n" : ""))
            expect(await tabKey(f.run)).toBe("ttys009")
        })

        it('is "" when no ancestor has a tty (headless)', async () => {
            delete process.env.TMUX
            const f = runWith((argv) => (isAncestryProbe(argv) && argv[4] === SELF ? "1 ??\n" : ""))
            expect(await tabKey(f.run)).toBe("")
        })

        it('treats a Linux `?` no-tty like `??` (returns "" at chain end)', async () => {
            delete process.env.TMUX
            const f = runWith((argv) => (isAncestryProbe(argv) && argv[4] === SELF ? "1 ?\n" : ""))
            expect(await tabKey(f.run)).toBe("")
        })

        it('is "" when the probe degrades to an empty string', async () => {
            delete process.env.TMUX
            expect(await tabKey(async () => "")).toBe("")
        })
    })
})
