/**
 * serve.spec.ts — exercises serve.ts at two layers.
 *
 * UNIT (hermetic): the 503 concurrency cap (capConcurrency) — pass-through when
 * disabled, sheds over the ceiling, releases on completion.
 *
 * E2E (subprocess): drive `serve --dry-run` so effect() skips the bind/block and
 * the state write — the deterministic prelude (free-port scan, scheme +
 * idle/wait validation, the exact banner) still runs. Mirrors open-file.spec's
 * subprocess harness. The real bind/block can't be exercised here (it would
 * never return); the live golden-diff proves that path.
 */

import { describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { capConcurrency } from "./serve.ts"

const context = describe

// Spawn the CLI as a real subprocess under a throwaway state dir. --dry-run keeps
// every case hermetic: no port is bound, no state file is written.
const run = async (
    args: string[],
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "serve.ts"), ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...environment }
    })
    const [stdout, stderr] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text()
    ])
    const code = await subprocess.exited
    return { code, stdout, stderr }
}

describe("serve", () => {
    context("capConcurrency — the 503 in-flight ceiling", () => {
        it("is a pass-through when the cap is 0 (unlimited)", async () => {
            const handler = (): Response => new Response("ok", { status: 200 })
            const wrapped = capConcurrency(handler, 0)
            const res = await wrapped(new Request("http://x/"))
            expect(res.status).toBe(200)
        })

        it("sheds the over-the-ceiling request with a 503", async () => {
            let release = (): void => {}
            const gate = new Promise<void>((resolve) => {
                release = resolve
            })
            const handler = async (): Promise<Response> => {
                await gate
                return new Response("ok", { status: 200 })
            }
            const wrapped = capConcurrency(handler, 1)
            const first = wrapped(new Request("http://x/")) // takes the single slot, parks
            const second = await wrapped(new Request("http://x/")) // over the cap -> 503
            expect(second.status).toBe(503)
            release()
            expect((await first).status).toBe(200)
        })

        it("releases the slot once a request completes", async () => {
            const handler = (): Response => new Response("ok", { status: 200 })
            const wrapped = capConcurrency(handler, 1)
            expect((await wrapped(new Request("http://x/"))).status).toBe(200)
            // slot was released -> the next request is served, not shed.
            expect((await wrapped(new Request("http://x/"))).status).toBe(200)
        })
    })

    context("as a subprocess under --dry-run", () => {
        it("prints the exact greppable banner and exits 0", async () => {
            const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wire-serve-"))
            try {
                const { code, stdout } = await run(
                    [
                        "serve",
                        "--dry-run",
                        "--topic",
                        "t",
                        "--host",
                        "127.0.0.1",
                        "--port",
                        "5599",
                        "--secret",
                        "abc123"
                    ],
                    { WIRE_STATE_DIR: dir }
                )
                expect(code).toBe(0)
                // the banner shape is load-bearing (skills grep it) — pin it exactly,
                // only the live pid varying. Nothing else may print to stdout.
                const pid = stdout.match(/pid=(\d+)/)?.[1]
                expect(pid).toBeDefined()
                expect(stdout).toBe(`wire: ready host=127.0.0.1 port=5599 pid=${pid} secret=abc123\n`)
            } finally {
                await fs.rm(dir, { recursive: true, force: true })
            }
        })

        it("resolves a free port at/above the start port (banner reports the bound port)", async () => {
            const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wire-serve-"))
            // Occupy the start port so the scan must advance past it.
            const blocker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") })
            try {
                const start = blocker.port ?? 0
                const { code, stdout } = await run(
                    ["serve", "--dry-run", "--topic", "t", "--host", "127.0.0.1", "--port", String(start)],
                    { WIRE_STATE_DIR: dir }
                )
                expect(code).toBe(0)
                const match = stdout.match(/port=(\d+)/)
                expect(match).not.toBeNull()
                const reported = Number(match?.[1])
                expect(reported).toBeGreaterThan(start) // advanced past the occupied port
            } finally {
                blocker.stop(true)
                await fs.rm(dir, { recursive: true, force: true })
            }
        })

        it("does NOT write a state file under --dry-run (effect skips the write)", async () => {
            const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wire-serve-"))
            try {
                const { code } = await run(
                    ["serve", "--dry-run", "--topic", "t", "--host", "127.0.0.1", "--port", "5599"],
                    { WIRE_STATE_DIR: dir }
                )
                expect(code).toBe(0)
                const entries = await fs.readdir(dir)
                expect(entries).toEqual([])
            } finally {
                await fs.rm(dir, { recursive: true, force: true })
            }
        })

        it("exits 1 on a bad idle/wait config (idle-timeout <= wait-max)", async () => {
            const { code, stderr } = await run([
                "serve",
                "--dry-run",
                "--topic",
                "t",
                "--host",
                "127.0.0.1",
                "--idle-timeout",
                "10",
                "--wait-max",
                "60"
            ])
            expect(code).toBe(1)
            expect(stderr).toContain("wire: error:")
            expect(stderr).toContain("idleTimeout")
        })

        it("exits 1 on a public-url with no http(s) scheme", async () => {
            const { code, stderr } = await run([
                "serve",
                "--dry-run",
                "--topic",
                "t",
                "--host",
                "127.0.0.1",
                "--public-url",
                "ngrok.io"
            ])
            expect(code).toBe(1)
            expect(stderr).toContain("wire: error:")
            expect(stderr).toContain("http://")
        })

        it.each([
            ["a non-integer --port", ["serve", "--port", "abc", "--topic", "t"], "--port must be an integer"],
            ["an unknown flag", ["serve", "--bogus", "--topic", "t"], 'An option "--bogus" is unknown.'],
            ["a missing required --topic", ["serve", "--dry-run", "--host", "127.0.0.1"], "topic"]
        ] as [string, string[], string][])("exits 2 given %s", async (_label, args, fragment) => {
            const { code, stderr } = await run(args)
            expect(code).toBe(2)
            expect(stderr).toContain(fragment)
        })

        it("exits 0 and prints usage with --help", async () => {
            const { code, stdout } = await run(["serve", "--help"])
            expect(code).toBe(0)
            expect(stdout).toContain("serve")
        })
    })
})
