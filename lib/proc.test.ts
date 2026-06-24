/**
 * lib/proc.test.ts — also the canonical real-subprocess + timing mock pattern.
 *
 * MOCK PATTERN D — drive a real child process and assert on wall-clock behavior.
 * The headline contract test: spawning `sleep 5` under a 200ms timeout must KILL
 * the child (not leak it) and return promptly. We assert both `timedOut` and that
 * the elapsed time is far under the child's nominal 5s, proving the kill landed.
 */

import { describe, expect, test } from "bun:test"
import { spawn } from "./proc.ts"

describe("spawn", () => {
  test("kills the child when timeoutMs elapses (sleep 5 under 200ms)", async () => {
    const started = performance.now()
    const result = await spawn(["sleep", "5"], { timeoutMs: 200 })
    const elapsed = performance.now() - started

    expect(result.timedOut).toBe(true)
    // If the child were NOT killed we'd block ~5000ms; killed, we return in well under 2s.
    expect(elapsed).toBeLessThan(2000)
    // Killed by signal -> exitCode is null (or non-zero); definitely not a clean 0.
    expect(result.exitCode).not.toBe(0)
  }, 10_000)

  test("returns exit 0 and captures stdout for a fast command", async () => {
    const result = await spawn(["sh", "-c", "printf hello"], { timeoutMs: 5000 })
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("hello")
  })

  test("captures stderr and a non-zero exit without throwing", async () => {
    const result = await spawn(["sh", "-c", "printf oops >&2; exit 3"])
    expect(result.exitCode).toBe(3)
    expect(result.stderr).toBe("oops")
    expect(result.timedOut).toBe(false)
  })

  test("feeds stdin to the child", async () => {
    const result = await spawn(["cat"], { stdin: "piped-in" })
    expect(result.stdout).toBe("piped-in")
  })

  test("no timeout (omitted/0) lets a quick command finish normally", async () => {
    const result = await spawn(["sh", "-c", "exit 0"])
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(0)
  })

  test("throws only on an empty argv", () => {
    expect(() => spawn([])).toThrow()
  })
})
