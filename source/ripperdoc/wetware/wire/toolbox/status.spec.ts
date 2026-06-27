/**
 * status.spec.ts — exercises status.ts as a subprocess.
 *
 * status is read-only (no effect() gate), so these drive the real command under a
 * throwaway WIRE_STATE_DIR: not-running on an empty dir, "up" against a stub
 * /health, and "down" when state points at a port nothing answers. Ports the
 * status assertions from test_lifecycle's start/status/stop cycle.
 */

import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

const context = describe

const run = async (args: string[], stateDir: string): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "status.ts"), ...args], {
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

const writeState = async (stateDir: string, state: Record<string, unknown>): Promise<void> => {
    await fs.writeFile(path.join(stateDir, "wire.json"), JSON.stringify(state), "utf-8")
}

let dirs: string[] = []
const tmpStateDir = async (): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wire-status-"))
    dirs.push(dir)
    return dir
}
afterEach(async () => {
    for (const dir of dirs) {
        await fs.rm(dir, { recursive: true, force: true })
    }
    dirs = []
})

describe("status", () => {
    context("as a subprocess", () => {
        it("reports not running on an empty state dir (exit 0)", async () => {
            const dir = await tmpStateDir()
            const { code, stdout } = await run(["status"], dir)
            expect(code).toBe(0)
            expect(stdout).toContain("not running")
        })

        it("reports up with the address + secret when /health answers", async () => {
            const dir = await tmpStateDir()
            const health = Bun.serve({
                port: 0,
                hostname: "127.0.0.1",
                fetch: (req) =>
                    new URL(req.url).pathname === "/health" ? Response.json({ status: "ok" }) : new Response("x")
            })
            try {
                await writeState(dir, {
                    pid: process.pid,
                    host: "127.0.0.1",
                    port: health.port,
                    secret: "abc",
                    url: `http://127.0.0.1:${health.port}`,
                    topic: "t"
                })
                const { code, stdout } = await run(["status"], dir)
                expect(code).toBe(0)
                expect(stdout).toContain("wire: up")
                expect(stdout).toContain(`port:   ${health.port}`)
                expect(stdout).toContain("secret: abc")
                expect(stdout).toContain(`url:    http://127.0.0.1:${health.port}`)
            } finally {
                health.stop(true)
            }
        })

        it("reports down when nothing answers the tracked port", async () => {
            const dir = await tmpStateDir()
            // Port 1 is never our server -> the probe refuses -> down.
            await writeState(dir, {
                pid: process.pid,
                host: "127.0.0.1",
                port: 1,
                secret: "abc",
                url: "http://127.0.0.1:1",
                topic: "t"
            })
            const { code, stdout } = await run(["status"], dir)
            expect(code).toBe(0)
            expect(stdout).toContain("wire: down")
        })

        it("exits 2 on an unknown flag", async () => {
            const dir = await tmpStateDir()
            const { code, stderr } = await run(["status", "--bogus"], dir)
            expect(code).toBe(2)
            expect(stderr).toContain('An option "--bogus" is unknown.')
        })

        it("exits 0 and prints usage with --help", async () => {
            const dir = await tmpStateDir()
            const { code, stdout } = await run(["status", "--help"], dir)
            expect(code).toBe(0)
            expect(stdout).toContain("status")
        })
    })
})
