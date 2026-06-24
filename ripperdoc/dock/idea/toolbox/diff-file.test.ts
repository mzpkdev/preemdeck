/**
 * diff-file.test.ts — hermetic suite. The WRITE (launch) is mocked via cmdore's
 * `effect.mock` keyed by the wrapper reference; nothing spawns. The `inIdea` gate
 * is forced through the `PREEMDECK_FORCE_IN_IDEA` env override. Inputs are real
 * tmp files so strict resolution behaves like production (a missing input fails
 * fast). The `--wait` read-back uses the REAL FS: the mocked launch writes to the
 * resolved LEFT pane on the wait path, then the real readFile reads it.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { effect } from "cmdore"
import { diffFile, launch, main } from "./diff-file.ts"

const RECONCILED = "RECONCILED\n"
let dir = ""
let calls: Array<{ args: string[]; wait: boolean }>

/**
 * Mock the `launch` wrapper by reference: record argv + wait, spawn nothing; on
 * the wait path, optionally write `text` to `writeTo` (the resolved LEFT pane).
 */
const mockLaunch = (writeTo?: string, text = RECONCILED): void => {
  effect.mock(launch, async (args: string[], options: { wait?: boolean } = {}) => {
    const wait = options.wait ?? false
    calls.push({ args, wait })
    if (wait && writeTo !== undefined) {
      await writeFile(writeTo, text)
    }
    return {} as unknown as Bun.Subprocess
  })
}

const makeInputs = async (): Promise<{ target: string; suggestion: string }> => {
  const target = join(dir, "target.py")
  const suggestion = join(dir, "suggestion.py")
  await writeFile(target, "a\n")
  await writeFile(suggestion, "b\n")
  return { target, suggestion }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "preemdeck-difffile-"))
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

describe("diffFile", () => {
  test("threads resolved paths into argv (diff L R), async by default", async () => {
    const { target, suggestion } = await makeInputs()
    await diffFile(target, suggestion)
    expect(calls).toEqual([{ args: ["diff", await realpath(target), await realpath(suggestion)], wait: false }])
    expect(calls[0]?.args).not.toContain("--wait")
  })

  test("2-way wait watches LEFT (target) and returns its edited text", async () => {
    const { target, suggestion } = await makeInputs()
    mockLaunch(await realpath(target), "AFTER EDIT\n")
    expect(await diffFile(target, suggestion, true)).toBe("AFTER EDIT\n")
    expect(calls[0]?.wait).toBe(true)
  })

  test("wait untouched LEFT returns original", async () => {
    const { target, suggestion } = await makeInputs()
    expect(await diffFile(target, suggestion, true)).toBe("a\n")
  })

  test("no-wait returns null, launch wait=false", async () => {
    const { target, suggestion } = await makeInputs()
    expect(await diffFile(target, suggestion)).toBeNull()
    expect(calls[0]?.wait).toBe(false)
  })

  test("missing input throws before launch", async () => {
    const { target } = await makeInputs()
    await expect(diffFile(target, join(dir, "nope.py"))).rejects.toThrow()
    expect(calls).toEqual([])
  })
})

describe("main", () => {
  test("two files invoke diff, returns 0", async () => {
    const { target, suggestion } = await makeInputs()
    expect(await main([target, suggestion])).toBe(0)
    expect(calls).toEqual([{ args: ["diff", await realpath(target), await realpath(suggestion)], wait: false }])
  })

  test("--wait prints LEFT contents", async () => {
    const { target, suggestion } = await makeInputs()
    mockLaunch(await realpath(target), RECONCILED)
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never)
    try {
      expect(await main([target, suggestion, "--wait"])).toBe(0)
      expect(outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toBe(RECONCILED)
    } finally {
      outSpy.mockRestore()
    }
  })

  test("missing input -> 1", async () => {
    const { target } = await makeInputs()
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
    try {
      expect(await main([target, join(dir, "nope.py")])).toBe(1)
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("diff-file:")
    } finally {
      errSpy.mockRestore()
    }
  })

  test("no live IDE -> 1", async () => {
    process.env.PREEMDECK_FORCE_IN_IDEA = "0"
    const { target, suggestion } = await makeInputs()
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
    try {
      expect(await main([target, suggestion])).toBe(1)
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("diff-file:")
    } finally {
      errSpy.mockRestore()
    }
  })

  test("missing args -> CmdoreError mapped to exit 2 + diff-file: stderr", async () => {
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
    try {
      expect(await main(["only.py"])).toBe(2)
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("diff-file:")
    } finally {
      errSpy.mockRestore()
    }
  })

  test("--dry-run records the launch but skips the real spawn", async () => {
    const { target, suggestion } = await makeInputs()
    // No mock for launch: on dry-run cmdore flips effect.enabled off, so the
    // unmocked wrapper records the call and returns undefined without spawning.
    effect.reset()
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never)
    try {
      expect(await main([target, suggestion, "--dry-run"])).toBe(0)
      expect(effect.log.some((entry) => entry.wrapper === launch)).toBe(true)
      expect(calls.length).toBe(0)
    } finally {
      outSpy.mockRestore()
    }
  })
})
