/**
 * uninstall.spec.ts — bun-test suite for uninstall.ts.
 *
 * Seams: unregister/runCli shell out through install.ts's runCli, which spawns inline via
 * `Bun.spawn(argv, PIPED)` and reaps — we `spyOn(Bun, "spawn")` and serve a canned child
 * (`fakeChild`, built fresh per call so a command that spawns more than once never re-reads
 * a consumed stream), capturing the exact argv and scripting exit codes/stderr. A tmp mkdtemp
 * fixture backs the manifest + overlay FS (repoRoot is threaded into loadManifestOrExit /
 * writeManifest / main), and `spyOn(process, "exit")` drives the bail-out exit codes. The
 * spawn spy is restored in afterEach.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MANIFEST_SCHEMA, type OverlayRecord, STAGE_ROOT } from "./install.ts"
import { loadManifestOrExit, main, reverseOverlay, uninstallFor, unregister, writeManifest } from "./uninstall.ts"

const context = describe

// A canned Bun.Subprocess: stdout/stderr as drainable streams + a resolved exit.
// reap() reads the streams to text and awaits `exited`; built fresh per call so a
// command that spawns more than once never re-reads a consumed stream.
const fakeChild = (stdout = "", exitCode = 0, stderr = "") =>
    ({
        stdout: new Response(stdout).body,
        stderr: new Response(stderr).body,
        exited: Promise.resolve(exitCode),
        exitCode,
        kill() {}
    }) as unknown as Bun.Subprocess

// unregister/runCli shell out through install.runCli -> Bun.spawn; spy on Bun.spawn
// (no mock.module on the shared ./source/common/process.ts — it leaks across files) and
// restore it in afterEach. The default child exits 0.
let spawnSpy: ReturnType<typeof spyOn<typeof Bun, "spawn">>
const spawnCalls = (): string[][] => spawnSpy.mock.calls.map((c) => c[0] as string[])

let dir = ""
const MANIFEST_FILE = ".install-manifest.json"

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "preemdeck-uninstall-"))
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => fakeChild())
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    spawnSpy.mockRestore()
})

function seedManifest(payload: unknown): void {
    writeFileSync(join(dir, MANIFEST_FILE), typeof payload === "string" ? payload : JSON.stringify(payload))
}

function captureExit(fn: () => unknown): { code: number | null; stderr: string } {
    let code: number | null = null
    let stderr = ""
    const exitSpy = spyOn(process, "exit").mockImplementation(((c?: number) => {
        code = c ?? 0
        throw new Error(`__exit__:${code}`)
    }) as never)
    const errSpy = spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
        stderr += chunk
        return true
    }) as never)
    try {
        fn()
    } catch (e) {
        if (!(e instanceof Error) || !e.message.startsWith("__exit__:")) throw e
    } finally {
        exitSpy.mockRestore()
        errSpy.mockRestore()
    }
    return { code, stderr }
}

const silenceLog = () => spyOn(console, "log").mockImplementation(() => {})

describe("uninstall", () => {
    context("loadManifestOrExit", () => {
        it("reads a valid manifest", () => {
            const payload = { schema: MANIFEST_SCHEMA, harnesses: { claude: { overlay: [] } } }
            seedManifest(payload)
            expect(loadManifestOrExit(dir)).toEqual(payload)
        })

        it("missing -> exit 1", () => {
            const { code, stderr } = captureExit(() => loadManifestOrExit(dir))
            expect(code).toBe(1)
            expect(stderr).toContain("nothing to uninstall")
        })

        it("bad schema -> exit 1", () => {
            seedManifest({ schema: 2, harnesses: { claude: {} } })
            expect(captureExit(() => loadManifestOrExit(dir)).code).toBe(1)
        })
    })

    context("reverseOverlay", () => {
        it("restores from a backup", () => {
            const dst = join(dir, "settings.json")
            const bak = join(dir, "settings.json.bak")
            writeFileSync(dst, "overlay-content")
            writeFileSync(bak, "user-original")
            const records: OverlayRecord[] = [
                { dst, src: "source/overwrite/claude/settings.json", backup: bak, action: "overwrite" }
            ]
            const logSpy = silenceLog()
            try {
                expect(reverseOverlay(records, false)).toEqual([1, 0])
            } finally {
                logSpy.mockRestore()
            }
            expect(readFileSync(dst, "utf8")).toBe("user-original")
            expect(existsSync(bak)).toBe(false)
        })

        it("deletes when there is no backup", () => {
            const dst = join(dir, "fixer.md")
            writeFileSync(dst, "overlay-created")
            const records: OverlayRecord[] = [
                { dst, src: "source/overwrite/claude/fixer.md", backup: null, action: "create" }
            ]
            const logSpy = silenceLog()
            try {
                expect(reverseOverlay(records, false)).toEqual([0, 1])
            } finally {
                logSpy.mockRestore()
            }
            expect(existsSync(dst)).toBe(false)
        })

        it("tolerates an already-gone file", () => {
            const dst = join(dir, "gone.md")
            const records: OverlayRecord[] = [
                { dst, src: "source/overwrite/claude/gone.md", backup: null, action: "create" }
            ]
            const logSpy = silenceLog()
            try {
                expect(reverseOverlay(records, false)).toEqual([0, 0])
            } finally {
                logSpy.mockRestore()
            }
        })

        it("dry-run counts intent but writes nothing", () => {
            const dst = join(dir, "fixer.md")
            writeFileSync(dst, "overlay-created")
            const records: OverlayRecord[] = [
                { dst, src: "source/overwrite/claude/fixer.md", backup: null, action: "create" }
            ]
            const logSpy = silenceLog()
            try {
                expect(reverseOverlay(records, true)).toEqual([0, 1])
            } finally {
                logSpy.mockRestore()
            }
            expect(existsSync(dst)).toBe(true)
        })

        it("processes records in REVERSE order", () => {
            const a = join(dir, "a.md")
            const b = join(dir, "b.md")
            writeFileSync(a, "a")
            writeFileSync(b, "b")
            const records: OverlayRecord[] = [
                { dst: a, src: "source/overwrite/claude/a.md", backup: null, action: "create" },
                { dst: b, src: "source/overwrite/claude/b.md", backup: null, action: "create" }
            ]
            const lines: string[] = []
            const logSpy = spyOn(console, "log").mockImplementation(((line?: unknown) => {
                lines.push(String(line ?? ""))
            }) as never)
            try {
                reverseOverlay(records, false)
            } finally {
                logSpy.mockRestore()
            }
            const removed = lines.filter((l) => l.includes("removed")).map((l) => (l.includes("b.md") ? "b.md" : "a.md"))
            expect(removed).toEqual(["b.md", "a.md"])
        })
    })

    // unregister (command shapes via the spawn mock)
    context("unregister", () => {
        it("gemini uses extensions uninstall", async () => {
            const logSpy = silenceLog()
            try {
                const record = { plugins: [{ host: "gemini", rack: "dock", name: "fixer" }], marketplaces: [] }
                expect(await unregister("gemini", record, false)).toEqual([1, 0])
                expect(spawnCalls()).toEqual([["gemini", "extensions", "uninstall", "fixer"]])
            } finally {
                logSpy.mockRestore()
            }
        })

        it("claude unregisters plugin then marketplace by NAME", async () => {
            const logSpy = silenceLog()
            try {
                const record = {
                    plugins: [{ host: "claude", rack: "dock", name: "fixer" }],
                    marketplaces: ["dock"]
                }
                expect(await unregister("claude", record, false)).toEqual([1, 1])
                expect(spawnCalls()).toContainEqual(["claude", "plugin", "uninstall", "fixer"])
                expect(spawnCalls()).toContainEqual(["claude", "plugin", "marketplace", "remove", "dock"])
            } finally {
                logSpy.mockRestore()
            }
        })

        it("gemini skips marketplaces", async () => {
            const logSpy = silenceLog()
            try {
                const record = { plugins: [], marketplaces: ["dock"] }
                expect(await unregister("gemini", record, false)).toEqual([0, 0])
                expect(spawnCalls()).toEqual([])
            } finally {
                logSpy.mockRestore()
            }
        })

        it("tolerates 'not found' as already-done", async () => {
            spawnSpy.mockImplementation(() => fakeChild("", 1, "plugin not found"))
            const logSpy = silenceLog()
            try {
                const record = { plugins: [{ host: "claude", rack: "dock", name: "fixer" }], marketplaces: [] }
                const [pluginsDone] = await unregister("claude", record, false)
                expect(pluginsDone).toBe(1)
            } finally {
                logSpy.mockRestore()
            }
        })

        it("dry-run runs nothing but counts intent", async () => {
            const logSpy = silenceLog()
            try {
                const record = {
                    plugins: [{ host: "claude", rack: "dock", name: "fixer" }],
                    marketplaces: ["dock"]
                }
                expect(await unregister("claude", record, true)).toEqual([1, 1])
                expect(spawnCalls()).toEqual([])
            } finally {
                logSpy.mockRestore()
            }
        })
    })

    // writeManifest (uninstall's manifest mutation)
    context("writeManifest", () => {
        it("rewrites when harnesses remain", () => {
            const manifest = { schema: MANIFEST_SCHEMA, harnesses: { gemini: { overlay: [] } } }
            const logSpy = silenceLog()
            try {
                writeManifest(dir, manifest, false)
            } finally {
                logSpy.mockRestore()
            }
            const data = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"))
            expect(new Set(Object.keys(data.harnesses))).toEqual(new Set(["gemini"]))
        })

        it("deletes the file when empty", () => {
            seedManifest({ schema: MANIFEST_SCHEMA, harnesses: {} })
            writeManifest(dir, { schema: MANIFEST_SCHEMA, harnesses: {} }, false)
            expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false)
        })

        it("dry-run never writes", () => {
            const logSpy = silenceLog()
            try {
                writeManifest(dir, { schema: MANIFEST_SCHEMA, harnesses: { gemini: {} } }, true)
            } finally {
                logSpy.mockRestore()
            }
            expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false)
        })
    })

    // uninstallFor — skip path
    context("uninstallFor", () => {
        it("skips a harness absent from the manifest", async () => {
            const lines: string[] = []
            const logSpy = spyOn(console, "log").mockImplementation(((l?: unknown) => {
                lines.push(String(l ?? ""))
            }) as never)
            try {
                await uninstallFor("codex", { schema: MANIFEST_SCHEMA, harnesses: {} }, false)
            } finally {
                logSpy.mockRestore()
            }
            expect(lines.join("\n")).toContain("codex: not present in manifest")
            expect(spawnCalls()).toEqual([])
        })
    })

    // main (end-to-end manifest mutation)
    context("main", () => {
        it("drops the last harness and removes the file", async () => {
            const dst = join(dir, "settings.json")
            writeFileSync(dst, "overlay")
            seedManifest({
                schema: MANIFEST_SCHEMA,
                harnesses: {
                    claude: {
                        overlay: [
                            { dst, src: "source/overwrite/claude/settings.json", backup: null, action: "create" }
                        ],
                        marketplaces: [],
                        plugins: []
                    }
                }
            })
            const logSpy = silenceLog()
            try {
                const rc = await main(["claude"], dir)
                expect(rc).toBe(0)
                expect(existsSync(dst)).toBe(false)
                expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false)
            } finally {
                logSpy.mockRestore()
            }
        })

        it("drops one harness but keeps the others", async () => {
            seedManifest({
                schema: MANIFEST_SCHEMA,
                harnesses: {
                    claude: { overlay: [], marketplaces: [], plugins: [] },
                    gemini: { overlay: [], marketplaces: [], plugins: [] }
                }
            })
            const logSpy = silenceLog()
            try {
                const rc = await main(["claude"], dir)
                expect(rc).toBe(0)
                const data = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"))
                expect(new Set(Object.keys(data.harnesses))).toEqual(new Set(["gemini"]))
            } finally {
                logSpy.mockRestore()
            }
        })

        it("dry-run leaves the manifest intact", async () => {
            seedManifest({
                schema: MANIFEST_SCHEMA,
                harnesses: { claude: { overlay: [], marketplaces: [], plugins: [] } }
            })
            const logSpy = silenceLog()
            try {
                const rc = await main(["claude", "--dry-run"], dir)
                expect(rc).toBe(0)
                const data = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"))
                expect(new Set(Object.keys(data.harnesses))).toEqual(new Set(["claude"]))
            } finally {
                logSpy.mockRestore()
            }
        })

        it("removes the .stage mirror during teardown", async () => {
            const stage = join(dir, STAGE_ROOT, "dock", ".claude-plugin")
            mkdirSync(stage, { recursive: true })
            writeFileSync(join(stage, "marketplace.json"), "{}")
            seedManifest({
                schema: MANIFEST_SCHEMA,
                harnesses: { claude: { overlay: [], marketplaces: [], plugins: [] } }
            })
            const logSpy = silenceLog()
            try {
                await main(["claude"], dir)
            } finally {
                logSpy.mockRestore()
            }
            expect(existsSync(join(dir, STAGE_ROOT))).toBe(false)
        })

        it("dry-run leaves the .stage mirror intact", async () => {
            const stage = join(dir, STAGE_ROOT, "dock")
            mkdirSync(stage, { recursive: true })
            seedManifest({
                schema: MANIFEST_SCHEMA,
                harnesses: { claude: { overlay: [], marketplaces: [], plugins: [] } }
            })
            const logSpy = silenceLog()
            try {
                await main(["claude", "--dry-run"], dir)
            } finally {
                logSpy.mockRestore()
            }
            expect(existsSync(join(dir, STAGE_ROOT))).toBe(true)
        })
    })
})
