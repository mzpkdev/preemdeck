/**
 * serve.spec.ts — exercises serve.ts at two layers, never binding a real port.
 *
 * UNIT (hermetic): the pure builders — `resolveMdxPath`/`resolveCssPath` (a valid
 * file resolves absolute; a missing file or wrong extension throws a
 * `holo: error:`-shaped message), `buildViteConfig` (root points at `app`, the
 * alias maps `@holo-style`→the stylesheet, `server.fs.allow` covers the app + repo
 * roots), and `handlePlanIo` (GET reads the plan, POST writes the body back, other
 * methods are 405).
 *
 * E2E (subprocess): drive `serve --dry-run` so effect() skips createServer/listen
 * — the deterministic prelude (path validation, config build, the exact banner)
 * still runs. The real bind/block and the live `/__holo/plan` middleware can't be
 * exercised here (the server would never return); the live curl check proves them.
 */

import { describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
    buildViteConfig,
    consumeVerdictSidecar,
    createDisconnectReaper,
    DEFAULT_CSS,
    handleGateIo,
    handlePlanIo,
    handleVerdictIo,
    resolveCssPath,
    resolveMdxPath,
    ServeError,
    STYLE_ALIAS,
    verdictSidecarPath
} from "./serve"

const context = describe

// Spawn the CLI as a real subprocess. --dry-run keeps every case hermetic: no
// server is created, no port is bound.
const run = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "serve.ts"), ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env }
    })
    const [stdout, stderr] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text()
    ])
    const code = await subprocess.exited
    return { code, stdout, stderr }
}

/** Write a throwaway `.mdx` under a fresh temp dir; returns the dir and the file path. */
const fixtureMdx = async (name = "plan.mdx"): Promise<{ dir: string; file: string }> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "holo-serve-"))
    const file = path.join(dir, name)
    await fs.writeFile(file, "# Plan\n\n- one\n- two\n")
    return { dir, file }
}

describe("serve", () => {
    context("resolveMdxPath — path validation", () => {
        it("resolves a valid .mdx to an absolute path", async () => {
            const { dir, file } = await fixtureMdx()
            try {
                const abs = resolveMdxPath(file)
                expect(path.isAbsolute(abs)).toBe(true)
                expect(abs).toBe(file)
            } finally {
                await fs.rm(dir, { recursive: true, force: true })
            }
        })

        it("accepts .md as well as .mdx", async () => {
            const { dir, file } = await fixtureMdx("plan.md")
            try {
                expect(resolveMdxPath(file)).toBe(file)
            } finally {
                await fs.rm(dir, { recursive: true, force: true })
            }
        })

        it("resolves a relative path against cwd", async () => {
            const { dir, file } = await fixtureMdx()
            try {
                const rel = path.relative(process.cwd(), file)
                expect(resolveMdxPath(rel)).toBe(file)
            } finally {
                await fs.rm(dir, { recursive: true, force: true })
            }
        })

        it("throws a holo: error:-shaped message for a missing file", () => {
            const missing = path.join(os.tmpdir(), "holo-does-not-exist-xyz.mdx")
            expect(() => resolveMdxPath(missing)).toThrow(ServeError)
            expect(() => resolveMdxPath(missing)).toThrow(/does not exist/)
        })

        it("throws for a non-mdx/.md extension", async () => {
            const dir = await fs.mkdtemp(path.join(os.tmpdir(), "holo-serve-"))
            const file = path.join(dir, "notes.txt")
            await fs.writeFile(file, "nope")
            try {
                expect(() => resolveMdxPath(file)).toThrow(ServeError)
                expect(() => resolveMdxPath(file)).toThrow(/not a \.mdx or \.md file/)
            } finally {
                await fs.rm(dir, { recursive: true, force: true })
            }
        })

        it("throws when the path is a directory, not a file", async () => {
            const dir = await fs.mkdtemp(path.join(os.tmpdir(), "holo-serve-"))
            const sub = path.join(dir, "plan.mdx")
            await fs.mkdir(sub)
            try {
                expect(() => resolveMdxPath(sub)).toThrow(/not a regular file/)
            } finally {
                await fs.rm(dir, { recursive: true, force: true })
            }
        })
    })

    context("resolveCssPath — --css override validation", () => {
        it("resolves a valid .css to an absolute path", async () => {
            const dir = await fs.mkdtemp(path.join(os.tmpdir(), "holo-css-"))
            const file = path.join(dir, "theme.css")
            await fs.writeFile(file, ".holo { color: red; }\n")
            try {
                expect(resolveCssPath(file)).toBe(file)
            } finally {
                await fs.rm(dir, { recursive: true, force: true })
            }
        })

        it("throws a holo: error:-shaped message for a non-.css extension", async () => {
            const dir = await fs.mkdtemp(path.join(os.tmpdir(), "holo-css-"))
            const file = path.join(dir, "theme.scss")
            await fs.writeFile(file, "nope")
            try {
                expect(() => resolveCssPath(file)).toThrow(ServeError)
                expect(() => resolveCssPath(file)).toThrow(/not a \.css file/)
            } finally {
                await fs.rm(dir, { recursive: true, force: true })
            }
        })

        it("throws for a missing file", () => {
            const missing = path.join(os.tmpdir(), "holo-no-such-xyz.css")
            expect(() => resolveCssPath(missing)).toThrow(/does not exist/)
        })
    })

    context("buildViteConfig — the inline dev config", () => {
        it("roots at the committed app/ template dir and disables the config file", () => {
            const config = buildViteConfig({ host: "127.0.0.1", port: 5173 })
            expect(config.configFile).toBe(false)
            expect(config.appType).toBe("spa")
            expect(config.root).toBe(path.join(import.meta.dir, "app"))
        })

        it("aliases @holo-style to the built-in stylesheet when no --css is given", () => {
            const config = buildViteConfig({ host: "127.0.0.1", port: 5173 })
            const alias = config.resolve?.alias as Record<string, string>
            expect(alias[STYLE_ALIAS]).toBe(DEFAULT_CSS)
        })

        it("does NOT wire the old @holo-plan MDX alias (the editor fetches the plan at runtime)", () => {
            const config = buildViteConfig({ host: "127.0.0.1", port: 5173 })
            const alias = config.resolve?.alias as Record<string, string>
            expect(alias["@holo-plan"]).toBeUndefined()
        })

        it("aliases @holo-style to the --css override and allow-lists its dir", () => {
            const config = buildViteConfig({
                host: "127.0.0.1",
                port: 5173,
                css: "/themes/dracula.css"
            })
            const alias = config.resolve?.alias as Record<string, string>
            expect(alias[STYLE_ALIAS]).toBe("/themes/dracula.css")
            expect(config.server?.fs?.allow ?? []).toContain(path.dirname("/themes/dracula.css"))
        })

        it("allow-lists the app root and the repo root for file serving", () => {
            const config = buildViteConfig({ host: "127.0.0.1", port: 5173 })
            const allow = config.server?.fs?.allow ?? []
            expect(allow).toContain(path.join(import.meta.dir, "app"))
            expect(allow).toContain(path.resolve(import.meta.dir, "..", "..", "..", "..", "..", ".."))
        })

        it("threads host/port/open through to server.*", () => {
            const config = buildViteConfig({ host: "0.0.0.0", port: 5199, open: true })
            expect(config.server?.host).toBe("0.0.0.0")
            expect(config.server?.port).toBe(5199)
            expect(config.server?.open).toBe(true)
        })

        it("does NOT set strictPort (lets Vite auto-bump)", () => {
            const config = buildViteConfig({ host: "127.0.0.1", port: 5173 })
            expect(config.server?.strictPort).toBeUndefined()
        })
    })

    context("handlePlanIo — the /__holo/plan read/write logic", () => {
        it("GET reads the plan and returns it as text/plain, without writing", async () => {
            let wrote = false
            const result = await handlePlanIo("GET", async () => "should-not-be-read", {
                read: async () => "# Plan\n",
                write: async () => {
                    wrote = true
                }
            })
            expect(result.status).toBe(200)
            expect(result.body).toBe("# Plan\n")
            expect(result.contentType).toBe("text/plain; charset=utf-8")
            expect(wrote).toBe(false)
        })

        it("POST writes the request body back to the plan and returns 204 (no body)", async () => {
            let written: string | undefined
            const result = await handlePlanIo("POST", async () => "# Edited\n", {
                read: async () => "stale",
                write: async (text) => {
                    written = text
                }
            })
            expect(result.status).toBe(204)
            expect(result.body).toBeUndefined()
            expect(written).toBe("# Edited\n")
        })

        it("answers any other method with 405", async () => {
            const result = await handlePlanIo("DELETE", async () => "", {
                read: async () => "",
                write: async () => {}
            })
            expect(result.status).toBe(405)
        })
    })

    context("as a subprocess under --dry-run", () => {
        it("prints the exact greppable banner and exits 0 WITHOUT binding", async () => {
            const { dir, file } = await fixtureMdx()
            try {
                const { code, stdout, stderr } = await run(["--dry-run", file, "--host", "127.0.0.1", "--port", "5199"])
                expect(stderr).toBe("")
                expect(code).toBe(0)
                // the banner shape is load-bearing (skills grep it) — pin it exactly.
                expect(stdout).toBe(`holo: ready url=http://127.0.0.1:5199 mdx=${file}\n`)
            } finally {
                await fs.rm(dir, { recursive: true, force: true })
            }
        })

        it("exits 1 with a holo: error: banner for a missing file", async () => {
            const missing = path.join(os.tmpdir(), "holo-missing-abc.mdx")
            const { code, stderr } = await run(["--dry-run", missing])
            expect(code).toBe(1)
            expect(stderr).toContain("holo: error:")
            expect(stderr).toContain("does not exist")
        })

        it("exits 1 with a holo: error: banner for a non-mdx file", async () => {
            const dir = await fs.mkdtemp(path.join(os.tmpdir(), "holo-serve-"))
            const file = path.join(dir, "notes.txt")
            await fs.writeFile(file, "nope")
            try {
                const { code, stderr } = await run(["--dry-run", file])
                expect(code).toBe(1)
                expect(stderr).toContain("holo: error:")
                expect(stderr).toContain("not a .mdx or .md file")
            } finally {
                await fs.rm(dir, { recursive: true, force: true })
            }
        })

        it.each([
            ["a non-integer --port", ["--dry-run", "x.mdx", "--port", "abc"], "--port must be an integer"],
            ["an unknown flag", ["--dry-run", "x.mdx", "--bogus"], 'An option "--bogus" is unknown.'],
            ["a missing required <file>", ["--dry-run"], "file"]
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

/**
 * A deterministic fake-timer harness for the reaper: `setTimer` records a
 * deadline-tagged callback under a monotonic id; `advance(ms)` moves a virtual
 * clock forward and fires (once) every still-live timer whose deadline it passes.
 * No real `setTimeout`, so the reaper's timing is asserted synchronously.
 */
const fakeClock = (): {
    setTimer: (fn: () => void, ms: number) => number
    clearTimer: (id: number) => void
    advance: (ms: number) => void
} => {
    let now = 0
    let nextId = 1
    const pending = new Map<number, { at: number; fn: () => void }>()
    return {
        setTimer: (fn, ms) => {
            const id = nextId++
            pending.set(id, { at: now + ms, fn })
            return id
        },
        clearTimer: (id) => {
            pending.delete(id)
        },
        advance: (ms) => {
            now += ms
            for (const [id, timer] of [...pending]) {
                if (timer.at <= now) {
                    pending.delete(id)
                    timer.fn()
                }
            }
        }
    }
}

describe("createDisconnectReaper", () => {
    const GRACE = 5000
    const STARTUP = 60000

    it("reaps via the startup backstop when no client ever connects", () => {
        const clock = fakeClock()
        let reaped = 0
        const reaper = createDisconnectReaper({ ...clock, graceMs: GRACE, startupMs: STARTUP, onReap: () => reaped++ })
        reaper.start()
        clock.advance(STARTUP - 1)
        expect(reaped).toBe(0)
        clock.advance(1)
        expect(reaped).toBe(1)
    })

    it("first connect cancels the startup backstop (no reap even long after startupMs)", () => {
        const clock = fakeClock()
        let reaped = 0
        const reaper = createDisconnectReaper({ ...clock, graceMs: GRACE, startupMs: STARTUP, onReap: () => reaped++ })
        reaper.start()
        reaper.onConnect()
        clock.advance(STARTUP * 10)
        expect(reaped).toBe(0)
    })

    it("arms the grace timer when the last client disconnects, and reaps once it elapses", () => {
        const clock = fakeClock()
        let reaped = 0
        const reaper = createDisconnectReaper({ ...clock, graceMs: GRACE, startupMs: STARTUP, onReap: () => reaped++ })
        reaper.start()
        reaper.onConnect()
        reaper.onDisconnect()
        clock.advance(GRACE - 1)
        expect(reaped).toBe(0)
        clock.advance(1)
        expect(reaped).toBe(1)
    })

    it("a reconnect within the grace window cancels the reap (reload/HMR-fallback blip)", () => {
        const clock = fakeClock()
        let reaped = 0
        const reaper = createDisconnectReaper({ ...clock, graceMs: GRACE, startupMs: STARTUP, onReap: () => reaped++ })
        reaper.start()
        reaper.onConnect()
        reaper.onDisconnect()
        clock.advance(GRACE - 1) // still inside the window
        reaper.onConnect() // a full reload reconnected
        clock.advance(GRACE * 5) // long past the original window
        expect(reaped).toBe(0)
    })

    it("a disconnect that still leaves ≥1 client does NOT reap", () => {
        const clock = fakeClock()
        let reaped = 0
        const reaper = createDisconnectReaper({ ...clock, graceMs: GRACE, startupMs: STARTUP, onReap: () => reaped++ })
        reaper.start()
        reaper.onConnect() // count 1
        reaper.onConnect() // count 2 (e.g. a second tab)
        reaper.onDisconnect() // count 1 — one viewer remains
        clock.advance(GRACE * 5)
        expect(reaped).toBe(0)
    })

    it("never reaps before the first client connects (a stray disconnect is a no-op)", () => {
        const clock = fakeClock()
        let reaped = 0
        const reaper = createDisconnectReaper({ ...clock, graceMs: GRACE, startupMs: STARTUP, onReap: () => reaped++ })
        reaper.start()
        reaper.onDisconnect() // never seen a client — must not arm the grace timer
        clock.advance(GRACE * 5)
        expect(reaped).toBe(0)
        // the startup backstop is still the only live path
        clock.advance(STARTUP)
        expect(reaped).toBe(1)
    })

    it("reaps at most once (grace elapse then a later signal-style call is idempotent)", () => {
        const clock = fakeClock()
        let reaped = 0
        const reaper = createDisconnectReaper({ ...clock, graceMs: GRACE, startupMs: STARTUP, onReap: () => reaped++ })
        reaper.start()
        reaper.onConnect()
        reaper.onDisconnect()
        clock.advance(GRACE) // reaps
        reaper.onDisconnect() // a late event must not re-fire onReap
        clock.advance(GRACE * 5)
        expect(reaped).toBe(1)
    })
})

describe("the approval gate (--wait)", () => {
    context("handleGateIo", () => {
        it("GET reports waiting + nonce as JSON", () => {
            const result = handleGateIo("GET", true, "n-1")
            expect(result.status).toBe(200)
            expect(result.contentType).toContain("application/json")
            expect(JSON.parse(result.body ?? "")).toEqual({ waiting: true, nonce: "n-1" })
        })

        it("reports a non-gating serve as waiting: false", () => {
            expect(JSON.parse(handleGateIo("GET", false, "n-1").body ?? "").waiting).toBe(false)
        })

        it("rejects non-GET", () => {
            expect(handleGateIo("POST", true, "n-1").status).toBe(405)
        })
    })

    context("handleVerdictIo", () => {
        const gate = { waiting: true, nonce: "n-1" }

        it("accepts a nonce-matched approve/reject as 204 carrying the verdict", () => {
            expect(handleVerdictIo("POST", JSON.stringify({ verdict: "approve", nonce: "n-1" }), gate)).toEqual({
                status: 204,
                verdict: "approve"
            })
            expect(handleVerdictIo("POST", JSON.stringify({ verdict: "reject", nonce: "n-1" }), gate).verdict).toBe(
                "reject"
            )
        })

        it("405s non-POST and 409s a serve that is not gating", () => {
            expect(handleVerdictIo("GET", "", gate).status).toBe(405)
            expect(
                handleVerdictIo("POST", JSON.stringify({ verdict: "approve", nonce: "n-1" }), {
                    waiting: false,
                    nonce: "n-1"
                }).status
            ).toBe(409)
        })

        it("403s a nonce mismatch — the forgery guard", () => {
            const result = handleVerdictIo("POST", JSON.stringify({ verdict: "approve", nonce: "stolen" }), gate)
            expect(result.status).toBe(403)
            expect(result.verdict).toBeUndefined()
        })

        it("400s malformed JSON and unknown verdicts", () => {
            expect(handleVerdictIo("POST", "not json", gate).status).toBe(400)
            expect(handleVerdictIo("POST", JSON.stringify({ verdict: "maybe", nonce: "n-1" }), gate).status).toBe(400)
        })
    })

    context("verdict sidecar", () => {
        it("consumes a leftover verdict: returns it once, the file is gone after", async () => {
            const { file } = await fixtureMdx()
            await fs.writeFile(verdictSidecarPath(file), "approve")
            expect(consumeVerdictSidecar(file)).toBe("approve")
            expect(consumeVerdictSidecar(file)).toBeNull()
        })

        it("returns null when absent; junk is consumed too, never re-read", async () => {
            const { file } = await fixtureMdx()
            expect(consumeVerdictSidecar(file)).toBeNull()
            await fs.writeFile(verdictSidecarPath(file), "maybe")
            expect(consumeVerdictSidecar(file)).toBeNull()
            await expect(fs.access(verdictSidecarPath(file))).rejects.toBeDefined()
        })
    })

    context("the CLI", () => {
        it("accepts --wait on --dry-run and rehearses the banner without a sidecar interaction", async () => {
            const { file } = await fixtureMdx()
            await fs.writeFile(verdictSidecarPath(file), "approve")
            const result = await run([file, "--wait", "--dry-run"])
            expect(result.code).toBe(0)
            expect(result.stdout).toContain("holo: ready")
            // Dry-run rides effect(): the sidecar must NOT be consumed. (Boolean
            // probe rather than .resolves — Bun fulfils fs.access with null.)
            expect(
                await fs.access(verdictSidecarPath(file)).then(
                    () => true,
                    () => false
                )
            ).toBe(true)
        })

        it("short-circuits a real --wait on a leftover sidecar: prints the verdict, never binds", async () => {
            const { file } = await fixtureMdx()
            await fs.writeFile(verdictSidecarPath(file), "reject")
            const result = await run([file, "--wait"])
            expect(result.code).toBe(0)
            expect(result.stdout).toContain("holo: verdict=reject")
            expect(result.stdout).not.toContain("holo: ready")
            await expect(fs.access(verdictSidecarPath(file))).rejects.toBeDefined()
        })
    })
})
