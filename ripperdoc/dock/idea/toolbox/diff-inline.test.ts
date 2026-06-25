/**
 * diff-inline.test.ts — hermetic, COMPOSITE suite. diff-inline delegates to
 * diff-file's diffFile; we do NOT stub diffFile — it runs for real (spilling +
 * strict-resolve + read-back are exercised). The only thing mocked is the LEAF
 * write it bottoms out in: diff-file's `launch` wrapper, mocked by reference via
 * cmdore's `effect.mock`. On the wait path the mocked launch writes the
 * reconciled text to the LEFT pane (args[1] — the target temp), which diffFile's
 * real readFile then returns. diffInline's own effects stay real: `writeTemp`
 * hits the REAL FS, and the no-wait `reapLater` arms a REF'd setTimeout — tests
 * on that path spy `setTimeout` to confirm a reap was scheduled WITHOUT arming
 * the live 3s timer. The `inIdea` gate is forced via `PREEMDECK_FORCE_IN_IDEA`.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { effect } from "cmdore"
import { exists } from "../../../../lib/fs.ts"
// diff-file is the real delegate; we mock only its leaf `launch` wrapper.
import { launch } from "./diff-file.ts"
import { diffInline, main } from "./diff-inline.ts"

const RECONCILED = "RECONCILED\n"
// Snapshot each pane's contents at launch time (before wait-path cleanup), keyed
// by the realpath'd argv diffFile hands launch: args[1] = LEFT, args[2] = RIGHT.
let snap: { target: string; suggestion: string; wait: boolean; contents: Record<string, string> }

/**
 * Mock diff-file's `launch` by reference. diffFile calls it with
 * `["diff", targetAbs, suggestionAbs]` and `{ wait }`. We snapshot both panes,
 * then on the wait path write `edits` to the LEFT pane (args[1]) so diffFile's
 * real read-back returns it. Spawns nothing.
 */
const mockLaunch = (edits: string | null = RECONCILED): void => {
    snap = { target: "", suggestion: "", wait: false, contents: {} }
    effect.mock(launch, async (args: string[], options: { wait?: boolean } = {}) => {
        const left = args[1] as string
        const right = args[2] as string
        snap.target = left
        snap.suggestion = right
        snap.wait = options.wait ?? false
        snap.contents[left] = await readFile(left, { encoding: "utf8" })
        snap.contents[right] = await readFile(right, { encoding: "utf8" })
        if (snap.wait && edits !== null) {
            await Bun.write(left, edits)
        }
        return { pid: 4321 } as unknown as Bun.Subprocess
    })
}

beforeEach(() => {
    process.env.PREEMDECK_FORCE_IN_IDEA = "1"
    effect.reset()
    mockLaunch()
})
afterEach(() => {
    delete process.env.PREEMDECK_FORCE_IN_IDEA
    effect.reset()
})

describe("diffInline", () => {
    test("spills target/suggestion in order, returns reconciled, cleans up on wait", async () => {
        expect(await diffInline("alpha", "beta", { wait: true })).toBe(RECONCILED)
        expect(snap.contents[snap.target]).toBe("alpha")
        expect(snap.contents[snap.suggestion]).toBe("beta")
        expect(await exists(snap.target)).toBe(false)
        expect(await exists(snap.suggestion)).toBe(false)
    })

    test("suffix threads to both temp names", async () => {
        await diffInline("a", "b", { suffix: ".py", wait: true })
        expect(snap.target.endsWith(".py")).toBe(true)
        expect(snap.suggestion.endsWith(".py")).toBe(true)
    })

    test("no-wait returns null and schedules a reap for both temps", async () => {
        mockLaunch(null)
        // Capture the reap without arming the real ref'd timer.
        const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
            void fn // don't fire; just record that a reap was scheduled
            return 0 as unknown as ReturnType<typeof setTimeout>
        }) as never)
        try {
            expect(await diffInline("x", "y")).toBeNull()
            expect(timerSpy.mock.calls.length).toBe(1)
            // Both temps are still on disk (launch's read snapshot proves they were spilled).
            for (const p of [snap.target, snap.suggestion]) {
                expect(await exists(p)).toBe(true)
                await Bun.file(p).delete()
            }
        } finally {
            timerSpy.mockRestore()
        }
    })
})

describe("main", () => {
    test("two strings -> 0, wait prints LEFT", async () => {
        const outSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never)
        try {
            expect(await main(["old", "new", "--wait"])).toBe(0)
            expect(outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toBe(RECONCILED)
        } finally {
            outSpy.mockRestore()
        }
    })

    test("threads suffix + wait through to the temp names", async () => {
        const outSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never)
        try {
            await main(["a", "b", "--suffix", ".py", "--wait"])
            expect(snap.wait).toBe(true)
            expect(snap.target.endsWith(".py")).toBe(true)
            expect(snap.suggestion.endsWith(".py")).toBe(true)
        } finally {
            outSpy.mockRestore()
        }
    })

    test("no live IDE -> 1 before work", async () => {
        process.env.PREEMDECK_FORCE_IN_IDEA = "0"
        const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
        try {
            expect(await main(["a", "b"])).toBe(1)
            expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("diff-inline:")
        } finally {
            errSpy.mockRestore()
        }
    })

    test("missing args -> CmdoreError mapped to exit 2 + diff-inline: stderr", async () => {
        const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
        try {
            expect(await main(["only"])).toBe(2)
            expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("diff-inline:")
        } finally {
            errSpy.mockRestore()
        }
    })
})
