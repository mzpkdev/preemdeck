/**
 * in-idea.test.ts — gate-contract suite. The inIdea() detector is forced through
 * the `PREEMDECK_FORCE_IN_IDEA` env override ("1" in / "0" out), set per-test and
 * cleared in afterEach. Both branches are exercised. -q is this CLI's explicit
 * `silent` option (alias q), NOT cmdore's global --quiet: it drives the EXIT CODE
 * (0 in / 1 out) and suppresses the human line, but does not touch cmdore's own
 * output. Bad flags follow cmdore (CmdoreError usage error -> exit 2), distinct
 * from the gate's runtime 0/1.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { main } from "./in-idea.ts"

let logSpy: ReturnType<typeof spyOn>

beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
    delete process.env.PREEMDECK_FORCE_IN_IDEA
    logSpy.mockRestore()
})

describe("main", () => {
    test("inside -> prints the line and returns 0", async () => {
        process.env.PREEMDECK_FORCE_IN_IDEA = "1"
        expect(await main([])).toBe(0)
        expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toBe("in a JetBrains IDE terminal")
    })

    test("outside -> prints the line and returns 1", async () => {
        process.env.PREEMDECK_FORCE_IN_IDEA = "0"
        expect(await main([])).toBe(1)
        expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toBe("not in a JetBrains IDE terminal")
    })

    test("-q inside -> 0, no output", async () => {
        process.env.PREEMDECK_FORCE_IN_IDEA = "1"
        expect(await main(["-q"])).toBe(0)
        expect(logSpy.mock.calls.length).toBe(0)
    })

    test("-q outside -> 1, no output", async () => {
        process.env.PREEMDECK_FORCE_IN_IDEA = "0"
        expect(await main(["-q"])).toBe(1)
        expect(logSpy.mock.calls.length).toBe(0)
    })

    test("cmdore --quiet does not hijack the gate: still exits 1 outside", async () => {
        // The reserved global --quiet only mutes cmdore's own output; it must NOT
        // be conflated with -q's exit-code contract. Outside an IDE -> still 1.
        process.env.PREEMDECK_FORCE_IN_IDEA = "0"
        expect(await main(["--quiet"])).toBe(1)
    })

    test("unknown flag -> CmdoreError mapped to exit 2 + in-idea: stderr", async () => {
        process.env.PREEMDECK_FORCE_IN_IDEA = "1"
        const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
        try {
            expect(await main(["--bogus"])).toBe(2)
            const err = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")
            expect(err).toContain("in-idea:")
            expect(err).toContain("--bogus")
        } finally {
            errSpy.mockRestore()
        }
    })
})
