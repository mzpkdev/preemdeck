/**
 * open-file.test.ts — hermetic suite. The WRITES (launch, setPreview) are mocked
 * via cmdore's `effect.mock` keyed by the wrapper reference; nothing spawns. The
 * `inIdea` gate is forced through the `PREEMDECK_FORCE_IN_IDEA` env override. The
 * `--wait` read-back uses the REAL FS: tests write a real tmp file, the mocked
 * launch writes EDITED to it on the wait path, then the real readFile reads it.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { effect } from "cmdore"
import { launch, main, openFile, setPreview } from "./open-file.ts"

const ORIGINAL = "ORIGINAL\n"
const EDITED = "EDITED\n"
let dir = ""
let calls: Array<{ args: string[]; wait: boolean }>

/**
 * Mock the `launch` wrapper by reference: record argv + wait, spawn nothing; on
 * the wait path, optionally write `edits` to the resolved target (last argv).
 */
const mockLaunch = (edits?: string): void => {
  effect.mock(launch, async (args: string[], options: { wait?: boolean } = {}) => {
    const wait = options.wait ?? false
    calls.push({ args, wait })
    if (wait && edits !== undefined) {
      await writeFile(args[args.length - 1] as string, edits)
    }
    return { pid: 4321 } as unknown as Bun.Subprocess
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "preemdeck-openfile-"))
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

describe("openFile", () => {
  test("fire-and-forget by default: launch wait=false, returns null", async () => {
    const target = join(dir, "thing.py")
    await writeFile(target, ORIGINAL)
    expect(await openFile(target)).toBeNull()
    expect(calls[0]?.wait).toBe(false)
    expect(calls[0]?.args).toEqual(["--line", "1", target])
  })

  test("threads line + column into argv", async () => {
    const target = join(dir, "thing.py")
    await writeFile(target, ORIGINAL)
    await openFile(target, { line: 42, column: 7 })
    expect(calls[0]?.args).toEqual(["--line", "42", "--column", "7", target])
  })

  test("wait=true reads the file back (edited)", async () => {
    const target = join(dir, "thing.py")
    await writeFile(target, ORIGINAL)
    mockLaunch(EDITED)
    expect(await openFile(target, { wait: true })).toBe(EDITED)
    expect(calls[0]?.wait).toBe(true)
  })

  test("wait=true untouched returns original", async () => {
    const target = join(dir, "thing.py")
    await writeFile(target, ORIGINAL)
    expect(await openFile(target, { wait: true })).toBe(ORIGINAL)
  })

  test("preview=true calls setPreview after launch", async () => {
    const target = join(dir, "thing.md")
    await writeFile(target, ORIGINAL)
    const previewed: string[] = []
    effect.mock(setPreview, async (p: string) => {
      previewed.push(p)
    })
    await openFile(target, { preview: true })
    expect(previewed.length).toBe(1)
  })
})

describe("main", () => {
  test("no --wait prints nothing, returns 0", async () => {
    const target = join(dir, "thing.py")
    await writeFile(target, ORIGINAL)
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never)
    try {
      expect(await main([target])).toBe(0)
      expect(outSpy.mock.calls.length).toBe(0)
    } finally {
      outSpy.mockRestore()
    }
  })

  test("--wait prints the file contents verbatim", async () => {
    const target = join(dir, "thing.py")
    await writeFile(target, ORIGINAL)
    mockLaunch(EDITED)
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never)
    try {
      expect(await main([target, "--wait"])).toBe(0)
      expect(outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toBe(EDITED)
    } finally {
      outSpy.mockRestore()
    }
  })

  test("no live IDE -> 1", async () => {
    // Force the real gate shut; run() throws IdeaError before any launch.
    process.env.PREEMDECK_FORCE_IN_IDEA = "0"
    const target = join(dir, "thing.py")
    await writeFile(target, ORIGINAL)
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
    try {
      expect(await main([target])).toBe(1)
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("open-file:")
    } finally {
      errSpy.mockRestore()
    }
  })

  test("bad --line -> CmdoreError mapped to exit 2 + open-file: stderr", async () => {
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
    try {
      expect(await main(["--line", "abc", "foo.txt"])).toBe(2)
      const err = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")
      expect(err).toContain("open-file:")
      expect(err).toContain("--line must be an integer, got 'abc'")
    } finally {
      errSpy.mockRestore()
    }
  })

  test("--dry-run records the launch but skips the real spawn", async () => {
    const target = join(dir, "thing.py")
    await writeFile(target, ORIGINAL)
    // No mock for launch: on dry-run cmdore flips effect.enabled off, so the
    // unmocked wrapper records the call and returns undefined without spawning.
    effect.reset()
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never)
    try {
      expect(await main([target, "--dry-run"])).toBe(0)
      // Recorded the intended call...
      expect(effect.log.some((entry) => entry.wrapper === launch)).toBe(true)
      // ...but the recorder stub never ran (the real launch was skipped).
      expect(calls.length).toBe(0)
    } finally {
      outSpy.mockRestore()
    }
  })
})
