/**
 * lib/args.test.ts — the parseArgs convention + canonical process.exit mock.
 *
 * MOCK PATTERN F — spy on process.exit so a unit that exits 2 on a usage error is
 * testable without killing the runner. Replace exit with a thrown sentinel,
 * assert it threw with the expected code, and silence stderr alongside it. This
 * is THE pattern every ported CLI test reuses to assert exit codes.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { type ActionSpec, parseAction, parseIntArg, parseOrExit, UsageError, validateActions } from "./args.ts"

// Helper: install the exit/stderr spies, run `fn`, and report the exit code it
// requested (or null if it never exited). Restored in afterEach below.
const spies: Array<{ mockRestore: () => void }> = []

const captureExit = (fn: () => void): { code: number | null; stderr: string } => {
    let code: number | null = null
    let stderr = ""
    const exitSpy = spyOn(process, "exit").mockImplementation(((c?: number) => {
        code = c ?? 0
        throw new UsageError(`__exit__:${code}`) // unwind the stack like a real exit would
    }) as never)
    const errSpy = spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
        stderr += chunk
        return true
    }) as never)
    spies.push(exitSpy, errSpy)
    try {
        fn()
    } catch (e) {
        if (!(e instanceof UsageError)) throw e // re-throw anything that isn't our sentinel
    }
    return { code, stderr }
}

afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore()
})

describe("parseAction", () => {
    test("splits on the FIRST = only (keeps = in the arg)", () => {
        expect(parseAction("retry=http://h/?a=1&b=2")).toEqual({ name: "retry", arg: "http://h/?a=1&b=2" })
    })
    test("bare name -> arg null", () => {
        expect(parseAction("open")).toEqual({ name: "open", arg: null })
    })
})

describe("validateActions", () => {
    const spec: ActionSpec = { open: { needsArg: true }, dismiss: { needsArg: false } }

    test("accepts whitelisted actions in CLI order", () => {
        const out = validateActions("notify", ["open=/x", "dismiss"], spec)
        expect(out).toEqual([
            { name: "open", arg: "/x" },
            { name: "dismiss", arg: null }
        ])
    })

    test("unknown action -> exit 2 with a 'choose from' message", () => {
        const { code, stderr } = captureExit(() => validateActions("notify", ["bogus"], spec))
        expect(code).toBe(2)
        expect(stderr).toContain("unknown action 'bogus'")
        expect(stderr).toContain("choose from dismiss, open")
    })

    test("missing required arg -> exit 2", () => {
        const { code, stderr } = captureExit(() => validateActions("notify", ["open"], spec))
        expect(code).toBe(2)
        expect(stderr).toContain("needs an argument")
    })

    test("undefined raw -> empty list", () => {
        expect(validateActions("notify", undefined, spec)).toEqual([])
    })
})

describe("parseIntArg", () => {
    test("parses a clean integer", () => {
        expect(parseIntArg("p", "--timeout", "200")).toBe(200)
        expect(parseIntArg("p", "--n", "-5")).toBe(-5)
    })
    test("non-integer -> exit 2", () => {
        const { code, stderr } = captureExit(() => parseIntArg("p", "--timeout", "3.5"))
        expect(code).toBe(2)
        expect(stderr).toContain("invalid int value: '3.5'")
    })
    test("trailing garbage -> exit 2 (not a lenient parse)", () => {
        expect(captureExit(() => parseIntArg("p", "--n", "3abc")).code).toBe(2)
    })
})

describe("parseOrExit", () => {
    test("parses positionals + boolean flag", () => {
        const r = parseOrExit("open_url", {
            args: ["http://localhost:3000", "--quiet"],
            options: { quiet: { type: "boolean", short: "q" } },
            allowPositionals: true
        })
        expect(r.positionals).toEqual(["http://localhost:3000"])
        expect(r.values.quiet).toBe(true)
    })

    test("collects a repeatable --action into an array", () => {
        const r = parseOrExit("notify", {
            args: ["--action", "open=/x", "--action", "dismiss"],
            options: { action: { type: "string", multiple: true } },
            allowPositionals: true
        })
        expect(r.values.action).toEqual(["open=/x", "dismiss"])
    })

    test("an unknown option -> exit 2 (parseArgs throw is converted)", () => {
        const { code, stderr } = captureExit(() =>
            parseOrExit("p", { args: ["--nope"], options: {}, allowPositionals: true })
        )
        expect(code).toBe(2)
        expect(stderr).toContain("p:")
    })
})
