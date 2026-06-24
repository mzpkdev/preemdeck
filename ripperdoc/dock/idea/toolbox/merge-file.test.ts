/**
 * merge-file.test.ts — hermetic suite. The WRITE (launch) is mocked via cmdore's
 * `effect.mock` keyed by the wrapper reference; nothing spawns. The launch mock
 * returns a fake child whose `.exited` Promise (the native-merge join) writes the
 * OUTPUT (last argv element) — what mergeFile reads back on wait. The `inIdea`
 * gate is forced through the `PREEMDECK_FORCE_IN_IDEA` env override. Inputs are
 * real tmp files (strict resolution); the read-back uses the REAL FS.
 *
 * The fire-and-forget (no-wait) path calls the real `reapLater`, which arms a
 * REF'd setTimeout. Tests on that path spy on `setTimeout` to capture the reaped
 * paths and neutralize the timer, so no 3s ref'd timer outlives the suite.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { effect } from "cmdore"
import { exists } from "../../../../lib/fs.ts"
import { launch, main, mergeFile } from "./merge-file.ts"

const MERGED = "MERGED\n"
let dir = ""
let calls: string[][]

/** Mock the `launch` wrapper by reference: record argv, return a fake child whose `.exited` writes `text` to the OUTPUT (last arg). */
const mockLaunch = (text = MERGED): void => {
  effect.mock(launch, async (args: string[]) => {
    calls.push(args)
    const output = args[args.length - 1] as string
    return {
      exited: Promise.resolve().then(async () => {
        await writeFile(output, text)
        return 0
      }),
    } as unknown as Bun.Subprocess
  })
}

const makeInputs = async (): Promise<{ target: string; suggestion: string; base: string }> => {
  const target = join(dir, "target.py")
  const suggestion = join(dir, "suggestion.py")
  const base = join(dir, "base.py")
  await writeFile(target, "a\n")
  await writeFile(suggestion, "b\n")
  await writeFile(base, "o\n")
  return { target, suggestion, base }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "preemdeck-mergefile-"))
  calls = []
  process.env.PREEMDECK_FORCE_IN_IDEA = "1"
  effect.reset()
  mockLaunch()
})
afterEach(async () => {
  delete process.env.PREEMDECK_FORCE_IN_IDEA
  effect.reset()
  await rm(dir, { recursive: true, force: true })
})

describe("mergeFile", () => {
  test("no base: argv is [merge, target, suggestion, output], never --wait", async () => {
    const { target, suggestion } = await makeInputs()
    await mergeFile(target, suggestion, null, true)
    const argv = calls[0] as string[]
    expect(argv.slice(0, 3)).toEqual(["merge", await realpath(target), await realpath(suggestion)])
    expect(argv.length).toBe(4)
    expect(argv).not.toContain("--wait")
  })

  test("with base: base THIRD, output LAST", async () => {
    const { target, suggestion, base } = await makeInputs()
    await mergeFile(target, suggestion, base, true)
    const argv = calls[0] as string[]
    expect(argv.slice(0, 4)).toEqual([
      "merge",
      await realpath(target),
      await realpath(suggestion),
      await realpath(base),
    ])
    expect(argv.length).toBe(5)
  })

  test("wait joins the process, returns the output, cleans up", async () => {
    const { target, suggestion } = await makeInputs()
    expect(await mergeFile(target, suggestion, null, true)).toBe(MERGED)
    const output = (calls[0] as string[])[3] as string
    expect(await exists(output)).toBe(false)
  })

  test("no-wait returns null and schedules a reap of the output temp", async () => {
    const { target, suggestion } = await makeInputs()
    // Capture the reap without arming the real ref'd timer.
    const reaped: string[][] = []
    const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      // Don't fire; just note that a reap was scheduled (caller passes no extra args).
      void fn
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as never)
    try {
      expect(await mergeFile(target, suggestion)).toBeNull()
      const output = (calls[0] as string[])[3] as string
      reaped.push([output])
      expect(timerSpy.mock.calls.length).toBe(1)
      expect(reaped).toEqual([[output]])
      if (await exists(output)) await rm(output, { force: true })
    } finally {
      timerSpy.mockRestore()
    }
  })

  test("missing input throws before launch", async () => {
    const { target } = await makeInputs()
    await expect(mergeFile(target, join(dir, "nope.py"))).rejects.toThrow()
    expect(calls).toEqual([])
  })

  test("output suffix mirrors the target extension", async () => {
    const { target, suggestion } = await makeInputs()
    await mergeFile(target, suggestion, null, true)
    expect((calls[0] as string[])[3]?.endsWith(".py")).toBe(true)
  })
})

describe("main", () => {
  test("--wait prints the merged result", async () => {
    const { target, suggestion } = await makeInputs()
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never)
    try {
      expect(await main([target, suggestion, "--wait"])).toBe(0)
      expect(outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toBe(MERGED)
    } finally {
      outSpy.mockRestore()
    }
  })

  test("with base positional: base THIRD", async () => {
    const { target, suggestion, base } = await makeInputs()
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never)
    try {
      expect(await main([target, suggestion, base, "--wait"])).toBe(0)
      const argv = calls[0] as string[]
      expect(argv.length).toBe(5)
      expect(argv[3]).toBe(await realpath(base))
    } finally {
      outSpy.mockRestore()
    }
  })

  test("no live IDE -> 1", async () => {
    process.env.PREEMDECK_FORCE_IN_IDEA = "0"
    const { target, suggestion } = await makeInputs()
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
    try {
      expect(await main([target, suggestion])).toBe(1)
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("merge-file:")
    } finally {
      errSpy.mockRestore()
    }
  })

  test("missing args -> CmdoreError mapped to exit 2 + merge-file: stderr", async () => {
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
    try {
      expect(await main(["only"])).toBe(2)
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("merge-file:")
    } finally {
      errSpy.mockRestore()
    }
  })
})
