/**
 * serve.spec.ts — exercises serve.ts at two layers, never binding a real port.
 *
 * UNIT (hermetic): the pure builders — `resolveMdxPath` (a valid `.mdx` resolves
 * absolute; a missing file and a non-MDX extension throw `holo: error:`-shaped
 * messages) and `buildViteConfig` (root points at `app`, the alias maps
 * `@holo-plan`→the abs mdx, `server.fs.allow` includes the mdx's dir).
 *
 * E2E (subprocess): drive `serve --dry-run` so effect() skips createServer/listen
 * — the deterministic prelude (path validation, config build, the exact banner)
 * still runs. The real bind/block can't be exercised here (it would never
 * return); the live curl check proves that path.
 */

import { describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
    buildViteConfig,
    createDisconnectReaper,
    DEFAULT_CSS,
    PLAN_ALIAS,
    resolveCssPath,
    resolveMdxPath,
    ServeError,
    STYLE_ALIAS
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
            const config = buildViteConfig("/abs/plan.mdx", { host: "127.0.0.1", port: 5173 })
            expect(config.configFile).toBe(false)
            expect(config.appType).toBe("spa")
            expect(config.root).toBe(path.join(import.meta.dir, "app"))
        })

        it("aliases @holo-plan to the absolute mdx path", () => {
            const config = buildViteConfig("/abs/plan.mdx", { host: "127.0.0.1", port: 5173 })
            const alias = config.resolve?.alias as Record<string, string>
            expect(alias[PLAN_ALIAS]).toBe("/abs/plan.mdx")
        })

        it("aliases @holo-style to the built-in stylesheet when no --css is given", () => {
            const config = buildViteConfig("/abs/plan.mdx", { host: "127.0.0.1", port: 5173 })
            const alias = config.resolve?.alias as Record<string, string>
            expect(alias[STYLE_ALIAS]).toBe(DEFAULT_CSS)
        })

        it("aliases @holo-style to the --css override and allow-lists its dir", () => {
            const config = buildViteConfig("/abs/plan.mdx", {
                host: "127.0.0.1",
                port: 5173,
                css: "/themes/dracula.css"
            })
            const alias = config.resolve?.alias as Record<string, string>
            expect(alias[STYLE_ALIAS]).toBe("/themes/dracula.css")
            expect(config.server?.fs?.allow ?? []).toContain(path.dirname("/themes/dracula.css"))
        })

        it("allow-lists the mdx's own directory for file serving", () => {
            const mdxPath = "/somewhere/deep/plan.mdx"
            const config = buildViteConfig(mdxPath, { host: "127.0.0.1", port: 5173 })
            const allow = config.server?.fs?.allow ?? []
            expect(allow).toContain(path.dirname(mdxPath))
            expect(allow).toContain(path.join(import.meta.dir, "app"))
        })

        it("threads host/port/open through to server.*", () => {
            const config = buildViteConfig("/abs/plan.mdx", { host: "0.0.0.0", port: 5199, open: true })
            expect(config.server?.host).toBe("0.0.0.0")
            expect(config.server?.port).toBe(5199)
            expect(config.server?.open).toBe(true)
        })

        it("does NOT set strictPort (lets Vite auto-bump)", () => {
            const config = buildViteConfig("/abs/plan.mdx", { host: "127.0.0.1", port: 5173 })
            expect(config.server?.strictPort).toBeUndefined()
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
