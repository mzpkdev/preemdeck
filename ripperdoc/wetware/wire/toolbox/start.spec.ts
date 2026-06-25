/**
 * start.spec.ts — exercises start.ts at two layers.
 *
 * UNIT (hermetic): serveArgv — the detached child's argv. The =value form (so a
 * dash-leading secret can't be misparsed), and the idle/sweep/empty/cap/
 * public-url knobs forwarded ONLY when set (an unset knob is omitted so the child
 * resolves its own env/default). Ports the load-bearing _serve_argv cases from
 * the original wire's lifecycle suite.
 *
 * E2E (subprocess): the real start -> status -> stop cycle, idempotent re-start
 * (no second server), and the mint-a-secret path — each under a throwaway
 * WIRE_STATE_DIR so it never touches a real ~/.wire and the spawned pid is torn
 * down. Plus the idempotent reuse path driven hermetically against a stub /health
 * (no real server spawned). Mirrors the original wire's start/status/stop suite.
 */

import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { serveArgv } from "./start.ts"

const context = describe

// Spawn a wire command `.ts` as a real subprocess under a given state dir.
const run = async (
    file: string,
    args: string[],
    stateDir: string
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, file), ...args], {
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

const readState = async (stateDir: string): Promise<Record<string, unknown> | null> => {
    try {
        return JSON.parse(await fs.readFile(path.join(stateDir, "wire.json"), "utf-8")) as Record<string, unknown>
    } catch {
        return null
    }
}

const pidGone = (pid: number): boolean => {
    try {
        process.kill(pid, 0)
        return false
    } catch {
        return true
    }
}

// Last-ditch: never leak a spawned server out of a failed test.
const forceKill = (pid: number | undefined): void => {
    if (pid === undefined) {
        return
    }
    try {
        process.kill(pid, "SIGKILL")
    } catch {
        // already gone.
    }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let dirs: string[] = []
const tmpStateDir = async (): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wire-start-"))
    dirs.push(dir)
    return dir
}
afterEach(async () => {
    for (const dir of dirs) {
        await fs.rm(dir, { recursive: true, force: true })
    }
    dirs = []
})

describe("start", () => {
    context("serveArgv — the detached child's argv", () => {
        const base = { host: "127.0.0.1", port: 5555, secret: "s", topic: "t" }

        it("uses the --opt=value form for every value-bearing flag", () => {
            const argv = serveArgv(base, "/x/serve.ts")
            expect(argv).toContain("--topic=t")
            expect(argv).toContain("--secret=s")
            expect(argv).toContain("--host=127.0.0.1")
            expect(argv).toContain("--port=5555")
            // execPath + serve.ts + the "serve" subcommand lead the argv.
            expect(argv[0]).toBe(process.execPath)
            expect(argv[1]).toBe("/x/serve.ts")
            expect(argv[2]).toBe("serve")
        })

        it("keeps a dash-leading secret bound to its flag (one =value token)", () => {
            const argv = serveArgv({ ...base, secret: "-dashy" }, "/x/serve.ts")
            expect(argv).toContain("--secret=-dashy")
            // never split into two tokens that the child would misparse.
            expect(argv).not.toContain("-dashy")
        })

        it("forwards each knob with =value only when set", () => {
            const argv = serveArgv(
                {
                    ...base,
                    idleTimeout: 400,
                    sweepInterval: 5,
                    emptyGrace: 3,
                    maxConnections: 256,
                    publicUrl: "https://x.ngrok.io"
                },
                "/x/serve.ts"
            )
            expect(argv).toContain("--idle-timeout=400")
            expect(argv).toContain("--sweep-interval=5")
            expect(argv).toContain("--empty-grace=3")
            expect(argv).toContain("--max-connections=256")
            expect(argv).toContain("--public-url=https://x.ngrok.io")
        })

        it("omits an unset knob so the child resolves its own env/default", () => {
            const argv = serveArgv({ ...base, emptyGrace: 3 }, "/x/serve.ts")
            expect(argv).toContain("--empty-grace=3")
            expect(argv.some((a) => a.startsWith("--idle-timeout"))).toBe(false)
            expect(argv.some((a) => a.startsWith("--sweep-interval"))).toBe(false)
            expect(argv.some((a) => a.startsWith("--max-connections"))).toBe(false)
            expect(argv.some((a) => a.startsWith("--public-url"))).toBe(false)
        })
    })

    context("idempotent reuse (hermetic — stub /health, no spawn)", () => {
        it("re-prints the handoff for a live room without spawning a second server", async () => {
            const dir = await tmpStateDir()
            // A stub server that answers /health like the real room.
            const health = Bun.serve({
                port: 0,
                hostname: "127.0.0.1",
                fetch: (req) =>
                    new URL(req.url).pathname === "/health" ? Response.json({ status: "ok" }) : new Response("x")
            })
            try {
                const state = {
                    pid: process.pid, // any live pid; reuse only checks state + /health
                    host: "127.0.0.1",
                    port: health.port,
                    secret: "live",
                    url: `http://127.0.0.1:${health.port}`,
                    topic: "t"
                }
                await fs.writeFile(path.join(dir, "wire.json"), JSON.stringify(state), "utf-8")
                const before = await readState(dir)

                const { code, stdout } = await run("start.ts", ["start", "--topic", "t", "--host", "127.0.0.1"], dir)
                expect(code).toBe(0)
                expect(stdout).toContain("Send this prompt to your other agents:")
                expect(stdout).toContain("/shard?secret=live")
                // state untouched: the same pid is still on disk, no respawn.
                expect(await readState(dir)).toEqual(before)
            } finally {
                health.stop(true)
            }
        })
    })

    context("the real start -> status -> stop cycle (subprocess)", () => {
        it("starts detached, reports up, then stops and clears state", async () => {
            const dir = await tmpStateDir()
            let pid: number | undefined
            try {
                const started = await run(
                    "start.ts",
                    ["start", "--topic", "t", "--secret", "s", "--host", "127.0.0.1"],
                    dir
                )
                expect(started.code).toBe(0)
                expect(started.stdout).toContain("Send this prompt to your other agents:")
                expect(started.stdout).toContain("/shard?secret=s")

                const state = await readState(dir)
                expect(state).not.toBeNull()
                pid = state?.pid as number
                expect(state?.host).toBe("127.0.0.1")
                expect(state?.secret).toBe("s")
                expect(started.stdout).toContain(state?.url as string)

                const statusUp = await run("status.ts", ["status"], dir)
                expect(statusUp.code).toBe(0)
                expect(statusUp.stdout).toContain("wire: up")
                expect(statusUp.stdout).toContain(`port:   ${state?.port}`)
                expect(statusUp.stdout).toContain("secret: s")

                const stopped = await run("stop.ts", ["stop"], dir)
                expect(stopped.code).toBe(0)
                expect(stopped.stdout).toContain("stopped")
                expect(await readState(dir)).toBeNull()

                const statusDown = await run("status.ts", ["status"], dir)
                expect(statusDown.stdout).toContain("not running")

                await sleep(300)
                expect(pidGone(pid)).toBe(true)
                pid = undefined
            } finally {
                forceKill(pid)
            }
        }, 40_000)

        it("is idempotent: a second start reuses the live room (same pid)", async () => {
            const dir = await tmpStateDir()
            let pid: number | undefined
            try {
                const first = await run(
                    "start.ts",
                    ["start", "--topic", "t", "--secret", "s", "--host", "127.0.0.1"],
                    dir
                )
                expect(first.code).toBe(0)
                pid = (await readState(dir))?.pid as number

                const second = await run(
                    "start.ts",
                    ["start", "--topic", "t", "--secret", "s", "--host", "127.0.0.1"],
                    dir
                )
                expect(second.code).toBe(0)
                expect(second.stdout).toContain("Send this prompt to your other agents:")
                expect((await readState(dir))?.pid).toBe(pid) // NOT a second server
            } finally {
                await run("stop.ts", ["stop"], dirs[0] ?? "")
                await sleep(300)
                forceKill(pid)
            }
        }, 40_000)

        it("mints a non-empty secret when --secret is omitted", async () => {
            const dir = await tmpStateDir()
            let pid: number | undefined
            try {
                const started = await run("start.ts", ["start", "--topic", "t", "--host", "127.0.0.1"], dir)
                expect(started.code).toBe(0)
                expect(started.stdout).toContain("Send this prompt to your other agents:")

                const state = await readState(dir)
                expect(state).not.toBeNull()
                pid = state?.pid as number
                const secret = state?.secret as string
                // generated, non-empty, and not a passed-in value.
                expect(typeof secret).toBe("string")
                expect(secret.length).toBeGreaterThan(0)
                expect(secret).not.toBe("s")
                expect(started.stdout).toContain(`/shard?secret=${secret}`)

                const stopped = await run("stop.ts", ["stop"], dir)
                expect(stopped.code).toBe(0)
                expect(await readState(dir)).toBeNull()
                await sleep(300)
                expect(pidGone(pid)).toBe(true)
                pid = undefined
            } finally {
                forceKill(pid)
            }
        }, 40_000)
    })
})
