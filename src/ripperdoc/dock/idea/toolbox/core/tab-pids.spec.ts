/**
 * tab-pids.spec.ts — namespace-safe tab identity resolution through an injected
 * command seam. tmux resolves host client pids directly; direct shells retain
 * the tty-based pid fallback; TERM_SESSION_ID survives either path.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { normalizeTabTargets, type RunText, resolveTabPids, resolveTabTargets, type TabTargets } from "./tab-pids"

const SELF = String(process.pid)

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

const isAncestryProbe = (argv: string[]): boolean => argv[1] === "-o" && argv[2] === "ppid=,tty="

describe("normalizeTabTargets", () => {
    it("lifts legacy pid arrays without retaining the input array", () => {
        const pids = [12, 34]
        const targets = normalizeTabTargets(pids)
        pids.push(56)
        expect(targets).toEqual({ pids: [12, 34], termSessionIds: [] })
    })

    it("copies both arrays from the shared target contract", () => {
        const input: TabTargets = { pids: [12], termSessionIds: ["jediterm-1"] }
        const targets = normalizeTabTargets(input)
        input.pids.push(34)
        input.termSessionIds.push("jediterm-2")
        expect(targets).toEqual({ pids: [12], termSessionIds: ["jediterm-1"] })
    })
})

describe("resolveTabTargets", () => {
    it("keeps a trimmed TERM_SESSION_ID when no pid is visible", async () => {
        const targets = await resolveTabTargets(async () => "", { TERM_SESSION_ID: "  jediterm-1  " })
        expect(targets).toEqual({ pids: [], termSessionIds: ["jediterm-1"] })
    })

    it("uses tmux host client pids without calling ps", async () => {
        const f = runWith((argv) => {
            if (argv[1] === "display-message") return "work\n"
            if (argv[1] === "list-clients") return "310\n311\n310\n"
            return "SHOULD-NOT-RUN"
        })
        const targets = await resolveTabTargets(f.run, {
            TMUX: "/tmp/tmux",
            TERM_SESSION_ID: "jediterm-1"
        })
        expect(targets).toEqual({ pids: [310, 311], termSessionIds: ["jediterm-1"] })
        expect(f.calls).toContainEqual(["tmux", "list-clients", "-t", "work", "-F", "#{client_pid}"])
        expect(f.calls.some((argv) => argv[0] === "ps")).toBe(false)
    })

    it("drops invalid tmux client pids and dedupes mirrors", async () => {
        const f = runWith((argv) => {
            if (argv[1] === "display-message") return "work"
            if (argv[1] === "list-clients") return "0\n-4\nabc\n901\n901\n902\n"
            return ""
        })
        expect(await resolveTabTargets(f.run, { TMUX: "/tmp/tmux" })).toEqual({
            pids: [901, 902],
            termSessionIds: []
        })
    })

    it("does not list clients when tmux has no current session", async () => {
        const f = runWith((argv) => (argv[1] === "display-message" ? "  \n" : "SHOULD-NOT-RUN"))
        expect(await resolveTabTargets(f.run, { TMUX: "/tmp/tmux" })).toEqual({
            pids: [],
            termSessionIds: []
        })
        expect(f.calls.every((argv) => argv[1] !== "list-clients")).toBe(true)
    })

    it("falls back to pids on the nearest ancestor tty outside tmux", async () => {
        const ancestors: Record<string, string> = { [SELF]: "80108 ?\n", "80108": "77290 /dev/pts/3\n" }
        const f = runWith((argv) => {
            if (isAncestryProbe(argv)) return ancestors[argv[4] ?? ""] ?? ""
            if (argv[1] === "-t" && argv[2] === "pts/3") return "77290\n80108\n"
            return ""
        })
        expect(await resolveTabTargets(f.run, {})).toEqual({
            pids: [77290, 80108],
            termSessionIds: []
        })
        expect(f.calls).toContainEqual(["ps", "-t", "pts/3", "-o", "pid="])
    })

    it("returns an empty precise target when no identity resolves", async () => {
        expect(await resolveTabTargets(async () => "", {})).toEqual({ pids: [], termSessionIds: [] })
    })
})

describe("resolveTabPids compatibility", () => {
    const savedTmux = process.env.TMUX

    afterEach(() => {
        if (savedTmux === undefined) delete process.env.TMUX
        else process.env.TMUX = savedTmux
    })

    it("returns only the pid half of the shared targets", async () => {
        process.env.TMUX = "/tmp/tmux"
        const f = runWith((argv) => {
            if (argv[1] === "display-message") return "work"
            if (argv[1] === "list-clients") return "410\n411\n"
            return ""
        })
        expect(await resolveTabPids(f.run)).toEqual([410, 411])
    })
})
