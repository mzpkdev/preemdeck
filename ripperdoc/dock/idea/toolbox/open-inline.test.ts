/**
 * open-inline.test.ts — e2e: spawn the CLI as a real subprocess and assert on its
 * exit code, stdout, and stderr. The real IDE launch is neutralized with
 * --dry-run (cmdore flips effect.enabled off, so the launch/setPreview effects
 * are skipped), while arg parsing, the inIdea gate, the real temp-file spill, the
 * --wait read-back, and exit codes all run for real. PREEMDECK_FORCE_IN_IDEA
 * drives the live-IDE gate.
 *
 * Because launch is skipped under --dry-run, nothing edits the temp, so the --wait
 * read-back returns the spilled content verbatim — that is the externally
 * observable shadow of the old white-box roundtrip. The temp suffix and the
 * preview flip are not observable across the process boundary, so those flags are
 * only asserted to be accepted (exit 0).
 */

import { describe, expect, test } from "bun:test"
import { join } from "node:path"

const CLI = join(import.meta.dir, "open-inline.ts")

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

describe("open-inline CLI", () => {
  test("--dry-run on a live IDE exits 0 and writes nothing to stdout", async () => {
    const { code, stdout, stderr } = await run(["some text", "--dry-run"])
    expect(code).toBe(0)
    expect(stdout).toBe("")
    expect(stderr).toBe("")
  })

  test("--wait prints the spilled content back to stdout verbatim", async () => {
    const content = "hello inline\nsecond line\n"
    const { code, stdout } = await run([content, "--wait", "--dry-run"])
    expect(code).toBe(0)
    expect(stdout).toBe(content)
  })

  test("--suffix is accepted and exits 0", async () => {
    const { code, stdout, stderr } = await run(["x = 1", "--suffix", ".py", "--dry-run"])
    expect(code).toBe(0)
    expect(stdout).toBe("")
    expect(stderr).toBe("")
  })

  test("--preview is accepted and exits 0", async () => {
    const { code, stderr } = await run(["# title", "--suffix", ".md", "--preview", "--dry-run"])
    expect(code).toBe(0)
    expect(stderr).toBe("")
  })

  test("no live IDE exits 1 with the IdeaError on stderr", async () => {
    const { code, stdout, stderr } = await run(["body"], { PREEMDECK_FORCE_IN_IDEA: "0" })
    expect(code).toBe(1)
    expect(stdout).toBe("")
    expect(stderr).toContain("no JetBrains IDE in the process ancestry")
  })

  test("the inIdea gate fires before the dry-run skip", async () => {
    const { code, stderr } = await run(["body", "--dry-run"], { PREEMDECK_FORCE_IN_IDEA: "0" })
    expect(code).toBe(1)
    expect(stderr).toContain("open-inline: no JetBrains IDE in the process ancestry")
  })

  test("unknown flag exits 2", async () => {
    const { code, stderr } = await run(["body", "--bogus"])
    expect(code).toBe(2)
    expect(stderr).toContain('An option "--bogus" is unknown.')
  })

  test("missing required inline arg exits 2", async () => {
    const { code, stderr } = await run([])
    expect(code).toBe(2)
    expect(stderr).toContain('An argument "inline" is required.')
  })

  test("--help exits 0 and prints usage to stdout", async () => {
    const { code, stdout } = await run(["--help"])
    expect(code).toBe(0)
    expect(stdout).toContain("open-inline")
  })
})
