/**
 * read-logs.test.ts — real-FS e2e suite. A real tmp idea.log fixture backs the
 * read; `resolveLogDir` is pointed at it via `spyOn` on the core export (NOT
 * mock.module, which leaks across Bun's single-run suite). The `inIdea` gate is
 * forced through the `PREEMDECK_FORCE_IN_IDEA` env override. Exit codes/messages
 * follow cmdore (a bad `n` is a usage CmdoreError -> exit 2), distinct from the
 * runtime IdeaError / no-IDE exits, which stay 1.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { IdeaError } from "./core/errors.ts"
import * as core from "./core/index.ts"
import { main, readLogs } from "./read-logs.ts"

let dir = ""
let logSpy: ReturnType<typeof spyOn>
let logDirSpy: ReturnType<typeof spyOn>

const writeLog = async (lines: string[]): Promise<void> => {
  await writeFile(join(dir, "idea.log"), lines.map((l) => `${l}\n`).join(""))
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "preemdeck-readlogs-"))
  process.env.PREEMDECK_FORCE_IN_IDEA = "1"
  logDirSpy = spyOn(core, "resolveLogDir").mockImplementation(async () => dir)
  logSpy = spyOn(console, "log").mockImplementation(() => {})
})
afterEach(async () => {
  delete process.env.PREEMDECK_FORCE_IN_IDEA
  logDirSpy.mockRestore()
  logSpy.mockRestore()
  await rm(dir, { recursive: true, force: true })
})

describe("readLogs", () => {
  test("returns the last n lines in order", async () => {
    await writeLog(["one", "two", "three", "four", "five"])
    expect(await readLogs(3)).toEqual(["three", "four", "five"])
  })

  test("n larger than file returns all lines", async () => {
    await writeLog(["alpha", "bravo", "charlie"])
    expect(await readLogs(999)).toEqual(["alpha", "bravo", "charlie"])
  })

  test("default returns last 50", async () => {
    const lines = Array.from({ length: 120 }, (_, i) => `line-${i}`)
    await writeLog(lines)
    expect(await readLogs()).toEqual(lines.slice(-50))
  })

  test("propagates IdeaError from resolveLogDir", async () => {
    logDirSpy.mockImplementation(async () => {
      throw new IdeaError("no IDE")
    })
    await expect(readLogs(5)).rejects.toThrow(IdeaError)
  })
})

describe("main", () => {
  test("no args prints last 50, returns 0", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line-${i}`)
    await writeLog(lines)
    expect(await main([])).toBe(0)
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toBe(lines.slice(-50).join("\n"))
  })

  test("n arg prints last n joined by newlines", async () => {
    await writeLog(["a", "b", "c", "d"])
    expect(await main(["3"])).toBe(0)
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toBe("b\nc\nd")
  })

  test("returns 1 on IdeaError, nothing to stdout", async () => {
    logDirSpy.mockImplementation(async () => {
      throw new IdeaError("no IDE")
    })
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
    try {
      expect(await main([])).toBe(1)
      expect(logSpy.mock.calls.length).toBe(0)
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("read-logs:")
    } finally {
      errSpy.mockRestore()
    }
  })

  test("outside JetBrains -> 1 before work, never reads", async () => {
    process.env.PREEMDECK_FORCE_IN_IDEA = "0"
    logDirSpy.mockImplementation(async () => {
      throw new Error("must not be reached")
    })
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
    try {
      expect(await main([])).toBe(1)
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain(
        "read-logs: no JetBrains IDE in the process ancestry",
      )
    } finally {
      errSpy.mockRestore()
    }
  })

  test("non-int arg -> CmdoreError mapped to exit 2 + read-logs: stderr", async () => {
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
    try {
      expect(await main(["abc"])).toBe(2)
      const err = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")
      expect(err).toContain("read-logs:")
      expect(err).toContain("n must be an integer, got 'abc'")
    } finally {
      errSpy.mockRestore()
    }
  })
})
