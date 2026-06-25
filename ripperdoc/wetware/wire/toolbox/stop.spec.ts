/**
 * stop.spec.ts — exercises stop.ts at two layers.
 *
 * UNIT (hermetic): pidAlive — a probe (kill(pid, 0)) that is true for this
 * process and false for a surely-dead pid.
 *
 * E2E (subprocess): nothing-running, and the stale-state path — a state file
 * whose pid is dead is cleaned up (exit 0, no signal). The live TERM/KILL path is
 * covered by start.spec's real cycle. Each runs under a throwaway WIRE_STATE_DIR.
 * Ports test_lifecycle's test_stop_clears_stale_state + test_stop_nothing_running.
 */

import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { pidAlive } from "./stop.ts"

const context = describe

const run = async (args: string[], stateDir: string): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "stop.ts"), ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, WIRE_STATE_DIR: stateDir }
    })
    const [stdout, stderr] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text()
    ])
    const code = await subprocess.exited
    return { code, stdout, stderr }
}

const stateExists = async (stateDir: string): Promise<boolean> => {
    try {
        await fs.access(path.join(stateDir, "wire.json"))
        return true
    } catch {
        return false
    }
}

let dirs: string[] = []
const tmpStateDir = async (): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wire-stop-"))
    dirs.push(dir)
    return dir
}
afterEach(async () => {
    for (const dir of dirs) {
        await fs.rm(dir, { recursive: true, force: true })
    }
    dirs = []
})

describe("stop", () => {
    context("pidAlive — the kill(pid, 0) liveness probe", () => {
        it("is true for the running test process", () => {
            expect(pidAlive(process.pid)).toBe(true)
        })
        it("is false for a surely-dead pid", () => {
            // PID 2^31-1 is never a live process on these platforms.
            expect(pidAlive(2_147_483_646)).toBe(false)
        })
    })

    context("as a subprocess", () => {
        it("reports nothing running on an empty state dir (exit 0)", async () => {
            const dir = await tmpStateDir()
            const { code, stdout } = await run(["stop"], dir)
            expect(code).toBe(0)
            expect(stdout).toContain("nothing running")
        })

        it("clears stale state when the tracked pid is dead (exit 0, no signal)", async () => {
            const dir = await tmpStateDir()
            const state = {
                pid: 2_147_483_646, // a dead pid -> the stale-state branch
                host: "127.0.0.1",
                port: 5557,
                secret: "s",
                url: "http://127.0.0.1:5557",
                topic: "t"
            }
            await fs.writeFile(path.join(dir, "wire.json"), JSON.stringify(state), "utf-8")

            const { code, stdout } = await run(["stop"], dir)
            expect(code).toBe(0)
            expect(stdout).toContain("stale state cleared")
            expect(await stateExists(dir)).toBe(false)
        })

        it("rehearses under --dry-run without clearing the stale file", async () => {
            const dir = await tmpStateDir()
            const state = {
                pid: 2_147_483_646,
                host: "127.0.0.1",
                port: 5557,
                secret: "s",
                url: "http://127.0.0.1:5557",
                topic: "t"
            }
            await fs.writeFile(path.join(dir, "wire.json"), JSON.stringify(state), "utf-8")

            const { code } = await run(["stop", "--dry-run"], dir)
            expect(code).toBe(0)
            // the clearState rides effect() -> skipped on dry-run, file survives.
            expect(await stateExists(dir)).toBe(true)
        })

        it("exits 2 on an unknown flag", async () => {
            const dir = await tmpStateDir()
            const { code, stderr } = await run(["stop", "--bogus"], dir)
            expect(code).toBe(2)
            expect(stderr).toContain('An option "--bogus" is unknown.')
        })

        it("exits 0 and prints usage with --help", async () => {
            const dir = await tmpStateDir()
            const { code, stdout } = await run(["stop", "--help"], dir)
            expect(code).toBe(0)
            expect(stdout).toContain("stop")
        })
    })
})
