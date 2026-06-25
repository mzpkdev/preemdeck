/**
 * open-file.test.ts — e2e: spawn the CLI as a real subprocess and assert on its
 * exit code, stdout, and stderr. The real IDE launch is neutralized with
 * --dry-run (cmdore flips effect.enabled off, so the launch effect is skipped),
 * while arg parsing, the inIdea gate, the --wait read-back, and exit codes all
 * run for real. PREEMDECK_FORCE_IN_IDEA drives the live-IDE gate.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CLI = join(import.meta.dir, "open-file.ts")
const ORIGINAL = "ORIGINAL\n"

type Result = { code: number; stdout: string; stderr: string }

const run = async (args: string[], env: Record<string, string> = {}): Promise<Result> => {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PREEMDECK_FORCE_IN_IDEA: "1", ...env },
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  return { code, stdout, stderr }
}

let dir = ""
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "preemdeck-openfile-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("open-file CLI", () => {
  test("--dry-run on a live IDE exits 0 and writes nothing to stdout", async () => {
    const target = join(dir, "thing.py")
    await writeFile(target, ORIGINAL)
    const { code, stdout, stderr } = await run(["--dry-run", target])
    expect(code).toBe(0)
    expect(stdout).toBe("")
    expect(stderr).toBe("")
  })

  test("--wait prints the file contents back to stdout", async () => {
    const target = join(dir, "thing.py")
    await writeFile(target, ORIGINAL)
    const { code, stdout } = await run(["--wait", "--dry-run", target])
    expect(code).toBe(0)
    expect(stdout).toBe(ORIGINAL)
  })

  test("no live IDE exits 1 with the IdeaError on stderr", async () => {
    const target = join(dir, "thing.py")
    await writeFile(target, ORIGINAL)
    const { code, stdout, stderr } = await run([target], { PREEMDECK_FORCE_IN_IDEA: "0" })
    expect(code).toBe(1)
    expect(stdout).toBe("")
    expect(stderr).toContain("no JetBrains IDE in the process ancestry")
  })

  test("bad --line exits 2 with the coercion message on stderr", async () => {
    const { code, stderr } = await run(["--line", "abc", "foo.txt"])
    expect(code).toBe(2)
    expect(stderr).toContain("--line must be an integer, got 'abc'")
  })

  test("unknown flag exits 2", async () => {
    const { code, stderr } = await run(["--bogus", "foo.txt"])
    expect(code).toBe(2)
    expect(stderr).toContain('An option "--bogus" is unknown.')
  })

  test("missing required path exits 2", async () => {
    const { code, stderr } = await run([])
    expect(code).toBe(2)
    expect(stderr).toContain('An argument "path" is required.')
  })

  test("--help exits 0 and prints usage to stdout", async () => {
    const { code, stdout } = await run(["--help"])
    expect(code).toBe(0)
    expect(stdout).toContain("open-file")
  })
})
