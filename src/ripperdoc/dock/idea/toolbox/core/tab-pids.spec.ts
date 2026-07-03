/**
 * tab-pids.spec.ts — the shell-side pid resolver, driven through an injected
 * RunText seam (no real tmux/ps spawns, save one defensive real-seam smoke).
 *
 * tmux path ($TMUX set): union the pids across EVERY `#{client_tty}` line from
 * list-clients; an empty session name short-circuits to []. Non-tmux path: this
 * process's own controlling tty, with macOS's "no tty" (`??`) short-circuiting to
 * []. bareTty strips `/dev/` before `ps -t`; pids dedupe across ttys; non-numeric
 * / blank / non-positive `ps` lines are dropped; any probe degrading to "" -> [].
 */

import { afterEach, describe, expect, it } from "bun:test"
import { type RunText, resolveTabPids, tabKey } from "./tab-pids"

const context = describe

const TMUX = "/tmp/tmux-501/default,1,0"

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
        it("targets this process's own controlling tty", async () => {
            delete process.env.TMUX
            const f = runWith((argv) => {
                if (argv[1] === "-o") return "ttys006\n" // ps -o tty= -p <pid>
                if (argv[1] === "-t") return "500\n501\n"
                return ""
            })
            expect(asc(await resolveTabPids(f.run))).toEqual([500, 501])
            expect(f.calls).toContainEqual(["ps", "-t", "ttys006", "-o", "pid="])
        })

        it("is [] when ps reports no controlling tty (`??`), and never runs ps -t", async () => {
            delete process.env.TMUX
            const f = runWith((argv) => (argv[1] === "-o" ? "??\n" : "SHOULD-NOT-RUN"))
            expect(await resolveTabPids(f.run)).toEqual([])
            expect(f.calls.every((c) => c[1] !== "-t")).toBe(true)
        })

        it("bareTty strips a leading /dev/ from the own-tty form", async () => {
            delete process.env.TMUX
            const f = runWith((argv) => {
                if (argv[1] === "-o") return "/dev/ttys009\n"
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
                if (argv[1] === "-o") return "ttys010\n"
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
        it("keys on this process's own controlling tty (bare form)", async () => {
            delete process.env.TMUX
            const f = runWith((argv) => (argv[1] === "-o" ? "ttys006\n" : "SHOULD-NOT-RUN"))
            expect(await tabKey(f.run)).toBe("ttys006")
            expect(f.calls).toEqual([["ps", "-o", "tty=", "-p", String(process.pid)]])
        })

        it("strips a leading /dev/ from the controlling tty", async () => {
            delete process.env.TMUX
            const f = runWith((argv) => (argv[1] === "-o" ? "/dev/ttys009\n" : ""))
            expect(await tabKey(f.run)).toBe("ttys009")
        })

        it('is "" when ps reports no controlling tty (`??`)', async () => {
            delete process.env.TMUX
            const f = runWith(() => "??\n")
            expect(await tabKey(f.run)).toBe("")
        })

        it('is "" when the probe degrades to an empty string', async () => {
            delete process.env.TMUX
            expect(await tabKey(async () => "")).toBe("")
        })
    })
})
