/**
 * merge-inline.test.ts — hermetic, COMPOSITE suite. merge-inline delegates to
 * merge-file's mergeFile() engine; we let that run FOR REAL and mock only the
 * leaf WRITE — merge-file's `launch` wrapper — via cmdore's `effect.mock` keyed
 * by the wrapper reference (imported from ./merge-file.ts). The launch mock
 * returns a fake child whose `.exited` Promise (the native-merge join) writes the
 * MERGED text to the OUTPUT temp (mergeFile's last argv element); mergeFile's
 * REAL read-back then returns it on the wait path. Reach-through, not stubbed.
 *
 * merge-inline's own effects stay real: `writeTemp` spills to the REAL FS (so
 * mergeFile's strict resolve + read-back see genuine files); `reapLater` is real
 * too. The fire-and-forget (no-wait) path arms REF'd setTimeouts (one in
 * mergeFile for the output temp, one in mergeInline for the input temps); tests
 * spy on `setTimeout` to confirm scheduling and neutralize the live timer, so no
 * ref'd timer outlives the suite.
 *
 * The `inIdea` gate is forced through the `PREEMDECK_FORCE_IN_IDEA` env override.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { effect } from "cmdore"
import { exists } from "../../../../lib/fs.ts"
import { launch } from "./merge-file.ts"
import { main, mergeInline } from "./merge-inline.ts"

const MERGED = "MERGED\n"
/** Inputs spilled by mergeInline, captured at launch time (mergeFile argv: [merge, target, suggestion, (base?), output]). */
let snap: { argv: string[]; contents: Record<string, string> }

/**
 * Mock merge-file's `launch` wrapper by reference: snapshot the merge argv and
 * the on-disk contents of every input temp (so we can assert what mergeInline
 * spilled), then return a fake child whose `.exited` writes MERGED to the OUTPUT
 * temp (last argv) — what mergeFile's real read-back returns on the wait path.
 */
const mockLaunch = (): void => {
  snap = { argv: [], contents: {} }
  effect.mock(launch, async (args: string[]) => {
    snap.argv = args
    // argv is [merge, target, suggestion, (base?), output]; inputs are all but the first and last.
    for (const p of args.slice(1, -1)) {
      snap.contents[p] = await readFile(p, { encoding: "utf8" })
    }
    const output = args[args.length - 1] as string
    return {
      exited: Promise.resolve().then(async () => {
        await Bun.write(output, MERGED)
        return 0
      }),
    } as unknown as Bun.Subprocess
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

describe("mergeInline", () => {
  test("spills target+suggestion (no base), returns merged, cleans up on wait", async () => {
    expect(await mergeInline("mine", "theirs", null, { wait: true })).toBe(MERGED)
    // argv: [merge, target, suggestion, output] — no base.
    const [, target, suggestion] = snap.argv
    expect(snap.argv.length).toBe(4)
    expect(snap.contents[target as string]).toBe("mine")
    expect(snap.contents[suggestion as string]).toBe("theirs")
    // wait=true unlinks the input temps after mergeFile returns.
    expect(await exists(target as string)).toBe(false)
    expect(await exists(suggestion as string)).toBe(false)
  })

  test("spills base when present (base THIRD in the merge argv)", async () => {
    await mergeInline("mine", "theirs", "ancestor", { wait: true })
    // argv: [merge, target, suggestion, base, output].
    expect(snap.argv.length).toBe(5)
    const base = snap.argv[3] as string
    expect(snap.contents[base]).toBe("ancestor")
  })

  test("suffix threads to every input temp", async () => {
    await mergeInline("a", "b", "c", { suffix: ".py", wait: true })
    // Inputs are argv[1..3] (target, suggestion, base); each spilled temp ends in the suffix.
    for (const p of snap.argv.slice(1, -1)) {
      expect((p as string).endsWith(".py")).toBe(true)
    }
  })

  test("no-wait returns null and schedules a reap of the input temps", async () => {
    // Capture the reaps without arming the real ref'd timers. Two reapLater calls
    // fire on the no-wait path: mergeFile reaps its output temp, then mergeInline
    // reaps the input temps. Spy setTimeout to neutralize both.
    const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      void fn // don't fire
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as never)
    try {
      expect(await mergeInline("x", "y", "z")).toBeNull()
      // Both the output reap (mergeFile) and the input reap (mergeInline) were scheduled.
      expect(timerSpy.mock.calls.length).toBe(2)
      // The input temps exist on disk (the real reap was neutralized, so clean up by hand).
      const inputs = snap.argv.slice(1, -1) as string[]
      expect(inputs.length).toBe(3)
      for (const p of inputs) expect(await exists(p)).toBe(true)
    } finally {
      timerSpy.mockRestore()
      // Reap was neutralized; remove the input + output temps by hand.
      for (const p of snap.argv.slice(1) as string[]) if (await exists(p)) await Bun.file(p).delete()
    }
  })
})

describe("main", () => {
  test("--wait prints the merged result", async () => {
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never)
    try {
      expect(await main(["mine", "theirs", "--wait"])).toBe(0)
      expect(outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toBe(MERGED)
    } finally {
      outSpy.mockRestore()
    }
  })

  test("threads base + suffix into the merge argv", async () => {
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never)
    try {
      expect(await main(["mine", "theirs", "base", "--suffix", ".py", "--wait"])).toBe(0)
      // argv: [merge, target, suggestion, base, output] — base present, .py suffix on every temp.
      expect(snap.argv.length).toBe(5)
      const base = snap.argv[3] as string
      expect(snap.contents[base]).toBe("base")
      for (const p of snap.argv.slice(1, -1)) expect((p as string).endsWith(".py")).toBe(true)
    } finally {
      outSpy.mockRestore()
    }
  })

  test("no live IDE -> 1 before any work", async () => {
    process.env.PREEMDECK_FORCE_IN_IDEA = "0"
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
    try {
      expect(await main(["a", "b"])).toBe(1)
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("merge-inline:")
      // The gate fails before any launch: no merge argv was captured.
      expect(snap.argv).toEqual([])
    } finally {
      errSpy.mockRestore()
    }
  })

  test("missing args -> CmdoreError mapped to exit 2 + merge-inline: stderr", async () => {
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
    try {
      expect(await main(["only"])).toBe(2)
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("merge-inline:")
    } finally {
      errSpy.mockRestore()
    }
  })
})
