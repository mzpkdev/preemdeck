/**
 * install.spec.ts — bun-test suite for install.ts.
 *
 * Seams: a per-call `fakeChild()` served through a `spyOn(Bun, "spawn")` stands in for
 * real children at the spawn seam (fresh, un-consumed streams every call); the one
 * exception is runCli's timeout test, which delegates the spy to the real Bun.spawn
 * (a real `sleep` child) under a tiny injected timeoutMs so reap's real timer fires
 * fast. A tmp mkdtemp fixture backs the real-FS cases, and `spyOn(process, "exit")`
 * drives the parseInstallArgs exit-code assertions. Every spy is restored in afterEach.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
    backupPath,
    buildMirror,
    CHECK,
    CONFIG_DIRNAMES,
    CONFIG_FILE,
    configDir,
    copyOverlay,
    CROSS,
    DEFAULT_CONFIG,
    detectHarnesses,
    installDeps,
    installFor,
    installPlugin,
    isMirroredPrimitive,
    loadManifest,
    MANIFEST_FILE,
    MANIFEST_SCHEMA,
    manifestDir,
    type PluginSpec,
    parseInstallArgs,
    readPluginSpecs,
    refreshMarketplace,
    registerMarketplace,
    runCli,
    seedConfig,
    STAGE_ROOT,
    stampMirror,
    writeManifest
} from "./install"

const context = describe

// --- Bun.spawn seam ---------------------------------------------------------
// A canned Bun.Subprocess: stdout/stderr as drainable streams + a resolved exit.
// reap() reads the streams to text and awaits `exited`, so this stands in for a
// real child WITHOUT spawning one. Built per-call (fresh streams) below.
const fakeChild = (stdout = "", exitCode = 0, stderr = "") =>
    ({
        stdout: new Response(stdout).body,
        stderr: new Response(stderr).body,
        exited: Promise.resolve(exitCode),
        exitCode,
        kill() {}
    }) as unknown as Bun.Subprocess

// The genuine Bun.spawn, captured before any spying — the timeout test delegates
// the spy to it to drive reap's REAL timer against a real `sleep` child.
const realSpawn = Bun.spawn.bind(Bun)

// Record every Bun.spawn argv and serve a scripted child. Default: a clean exit 0.
let spawnSpy: ReturnType<typeof spyOn<typeof Bun, "spawn">>
const spawnCalls = (): string[][] => spawnSpy.mock.calls.map((c) => c[0] as string[])

let dir = ""

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "preemdeck-install-"))
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => fakeChild()) // default: every command succeeds
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    spawnSpy.mockRestore() // never leak the spy past this file
})

// Seed a fixture source/ripperdoc/ under repoRoot with BOTH allowlisted primitives and a
// representative spread of excluded files (code, docs, data, nested toolbox/scripts).
function seedRipperdoc(repoRoot: string): void {
    const w = (rel: string, body: string) => {
        const p = join(repoRoot, "source", "ripperdoc", rel)
        mkdirSync(join(p, ".."), { recursive: true })
        writeFileSync(p, body)
    }
    // allowlisted primitives
    w(
        "dock/.claude-plugin/marketplace.json",
        JSON.stringify({ name: "dock", plugins: [{ name: "idea", source: "./idea", version: "0.0.0" }] })
    )
    w("dock/.agents/plugins/marketplace.json", JSON.stringify({ name: "dock", plugins: [] }))
    w("dock/idea/.claude-plugin/plugin.json", JSON.stringify({ name: "idea", version: "0.0.0" }))
    w("dock/idea/.codex-plugin/plugin.json", JSON.stringify({ name: "idea", version: "0.0.0" }))
    w("dock/idea/.codex-plugin/hooks/hooks.json", JSON.stringify({ hooks: {} }))
    w("dock/idea/gemini-extension.json", JSON.stringify({ name: "idea", version: "0.0.0" }))
    w("dock/idea/skills/using/SKILL.md", "# using")
    w("wetware/directive/commands/swarm.toml", "name = 'swarm'")
    // excluded: code, docs, data, nested dirs
    w("dock/idea/toolbox/open-file.ts", "export const x = 1;")
    w("dock/idea/toolbox/core/index.ts", "export const y = 2;")
    w("dock/idea/scripts/build.ts", "// build")
    w("wetware/directive/skills/ask/directive.md", "# directive")
    w("wetware/directive/skills/ask/agents/openai.yaml", "name: ask")
    w("wetware/directive/scripts/modes.json", JSON.stringify({ modes: [] }))
    w("dock/idea/README.md", "# readme")
    w("wetware/ghost/engram.dat", "binary")
    w("wetware/ghost/stock/ENGRAM.md", "# stock")
    w("wetware/imprint/IMPRINT.md", "# imprint")
    w("wetware/imprint/hosts/host_gemini.md", "# host")
}

function walkRel(root: string): string[] {
    const out: string[] = []
    const { readdirSync: rd } = require("node:fs")
    for (const e of rd(root, { withFileTypes: true })) {
        const f = join(root, e.name)
        if (e.isDirectory()) {
            out.push(...walkRel(f).map((r) => `${e.name}/${r}`))
        } else {
            out.push(e.name)
        }
    }
    return out
}

function seedOverlay(repoRoot: string, harness = "claude"): void {
    const src = join(repoRoot, "source", "overwrite", harness)
    mkdirSync(join(src, "agents"), { recursive: true })
    writeFileSync(join(src, "settings.json"), '{"_": "overlay"}')
    writeFileSync(join(src, "agents", "fixer.md"), "# fixer overlay")
}

describe("install", () => {
    context("manifestDir", () => {
        it.each([
            ["claude", ".claude-plugin"],
            ["codex", ".agents/plugins"]
        ] as ["claude" | "codex", string][])("%s -> %s", (harness, expected) =>
            expect(manifestDir(harness)).toBe(expected)
        )
    })

    context("seedConfig", () => {
        it("writes preemdeck.json with the built-in defaults when absent", () => {
            seedConfig(dir, false)
            expect(readFileSync(join(dir, CONFIG_FILE), "utf8")).toBe(DEFAULT_CONFIG)
        })

        it("never overwrites an existing preemdeck.json", () => {
            writeFileSync(join(dir, CONFIG_FILE), '{"directive":{"strategy":"solo"}}\n')
            seedConfig(dir, false)
            expect(readFileSync(join(dir, CONFIG_FILE), "utf8")).toBe('{"directive":{"strategy":"solo"}}\n')
        })

        it("dry-run does not write", () => {
            seedConfig(dir, true)
            expect(existsSync(join(dir, CONFIG_FILE))).toBe(false)
        })
    })

    context("configDir", () => {
        // NOTE: configDir joins os.homedir() (not process.env.HOME). Bun's os.homedir()
        // snapshots $HOME at process startup on POSIX, so a runtime process.env.HOME
        // mutation is NOT observable here. The real CLI never mutates HOME mid-process,
        // and a spawned process WITH HOME set is honored (see the golden-diff harness),
        // so this holds at the only point that matters. Assert against the live homedir.
        it("joins the per-harness dirname onto the real home", () => {
            const home = homedir()
            expect(configDir("claude")).toBe(join(home, ".claude"))
            expect(configDir("codex")).toBe(join(home, ".codex"))
            expect(configDir("gemini")).toBe(join(home, ".gemini"))
        })

        it("CONFIG_DIRNAMES constant", () => {
            expect(CONFIG_DIRNAMES).toEqual({ claude: ".claude", codex: ".codex", gemini: ".gemini" })
        })
    })

    context("detectHarnesses", () => {
        // configDir() resolves against os.homedir() (snapshotted at process start,
        // un-fakeable mid-process — see the configDir note above), so inject a resolver
        // pointing at the tmp fixture instead of mutating $HOME.
        const resolveIn =
            (root: string) =>
            (h: string): string =>
                join(root, CONFIG_DIRNAMES[h] as string)

        it("returns hosts whose config dir exists, in HOSTS order", () => {
            mkdirSync(join(dir, ".claude"), { recursive: true })
            mkdirSync(join(dir, ".gemini"), { recursive: true })
            expect(detectHarnesses(resolveIn(dir))).toEqual(["claude", "gemini"])
        })

        it("detects all three when present", () => {
            for (const d of [".claude", ".codex", ".gemini"]) mkdirSync(join(dir, d), { recursive: true })
            expect(detectHarnesses(resolveIn(dir))).toEqual(["claude", "codex", "gemini"])
        })

        it("returns empty when none are present", () => {
            expect(detectHarnesses(resolveIn(dir))).toEqual([])
        })

        it("ignores a non-directory of the same name", () => {
            writeFileSync(join(dir, ".codex"), "i am a file, not a dir")
            expect(detectHarnesses(resolveIn(dir))).toEqual([])
        })
    })

    context("readPluginSpecs", () => {
        function seedMarketplace(payload: unknown): string {
            const md = join(dir, ".claude-plugin")
            mkdirSync(md, { recursive: true })
            writeFileSync(
                join(md, "marketplace.json"),
                typeof payload === "string" ? payload : JSON.stringify(payload)
            )
            return dir
        }

        it("returns empty when no manifest", () => {
            expect(readPluginSpecs(dir)).toEqual([])
        })

        it("parses names and paths", () => {
            const root = seedMarketplace({
                name: "test",
                plugins: [
                    { name: "git", source: "./git" },
                    { name: "gh", source: "./gh" }
                ]
            })
            const specs = readPluginSpecs(root)
            expect(specs.map((s) => s.name)).toEqual(["git", "gh"])
            expect(specs.map((s) => s.sourcePath)).toEqual([join(root, "git"), join(root, "gh")])
        })

        it("handles empty plugins array", () => {
            expect(readPluginSpecs(seedMarketplace({ name: "test", plugins: [] }))).toEqual([])
        })

        it("handles malformed json", () => {
            expect(readPluginSpecs(seedMarketplace("not valid json{"))).toEqual([])
        })

        it("skips entries missing name or source", () => {
            const root = seedMarketplace({
                name: "test",
                plugins: [
                    { name: "git", source: "./git" },
                    { source: "./orphan" },
                    { name: "no-source" },
                    { name: "bad-source-type", source: 42 }
                ]
            })
            expect(readPluginSpecs(root).map((s) => s.name)).toEqual(["git"])
        })

        it("skips disabled plugins (ghost)", () => {
            const root = seedMarketplace({
                name: "test",
                plugins: [
                    { name: "git", source: "./git" },
                    { name: "ghost", source: "./ghost" }
                ]
            })
            expect(readPluginSpecs(root).map((s) => s.name)).toEqual(["git"])
        })
    })

    // isMirroredPrimitive — the file-level allowlist gate
    context("isMirroredPrimitive", () => {
        it("ALLOWS every host-parsed primitive", () => {
            for (const p of [
                "/dock/.claude-plugin/marketplace.json",
                "/dock/idea/.claude-plugin/plugin.json",
                "/dock/.agents/plugins/marketplace.json",
                "/dock/idea/.codex-plugin/plugin.json",
                "/wetware/ghost/.codex-plugin/hooks/hooks.json",
                "/dock/idea/gemini-extension.json",
                "/dock/idea/skills/using/SKILL.md",
                "/wetware/directive/commands/ask.toml"
            ]) {
                expect(isMirroredPrimitive(p)).toBe(true)
            }
        })

        it("EXCLUDES code and non-primitive docs", () => {
            for (const p of [
                "/dock/idea/toolbox/open-file.ts",
                "/dock/idea/toolbox/core/index.ts",
                "/wetware/directive/scripts/inject-mode.ts",
                "/wetware/directive/scripts/modes.json",
                "/wetware/directive/skills/ask/directive.md",
                "/wetware/directive/skills/ask/agents/openai.yaml",
                "/wetware/imprint/README.md",
                "/wetware/imprint/IMPRINT.md",
                "/wetware/imprint/hosts/host_gemini.md",
                "/wetware/ghost/engram.dat",
                "/wetware/ghost/stock/ENGRAM.md"
            ]) {
                expect(isMirroredPrimitive(p)).toBe(false)
            }
        })
    })

    // buildMirror / stampMirror — primitives-only mirror
    context("buildMirror", () => {
        it("mirrors ONLY allowlisted primitives — no .ts, no excluded files", () => {
            seedRipperdoc(dir)
            const written = buildMirror(dir, false)

            const stage = join(dir, STAGE_ROOT)
            const all = walkRel(stage).sort()
            // exact allowlist set, with rack-relative structure preserved
            expect(all).toEqual([
                "dock/.agents/plugins/marketplace.json",
                "dock/.claude-plugin/marketplace.json",
                "dock/idea/.claude-plugin/plugin.json",
                "dock/idea/.codex-plugin/hooks/hooks.json",
                "dock/idea/.codex-plugin/plugin.json",
                "dock/idea/gemini-extension.json",
                "dock/idea/skills/using/SKILL.md",
                "wetware/directive/commands/swarm.toml"
            ])
            // NEVER any executable code
            expect(all.filter((p) => p.endsWith(".ts"))).toEqual([])
            // every excluded artifact is absent
            for (const gone of [
                "directive.md",
                "openai.yaml",
                "modes.json",
                "README.md",
                "engram.dat",
                "ENGRAM.md",
                "IMPRINT.md",
                "host_gemini.md"
            ]) {
                expect(all.some((p) => p.endsWith(gone))).toBe(false)
            }
            // returns absolute paths to everything it wrote
            expect(written.length).toBe(all.length)
            expect(written.every((p) => p.startsWith(join(dir, STAGE_ROOT)))).toBe(true)
        })

        it("rebuilds from scratch — a stale primitive does not survive", () => {
            seedRipperdoc(dir)
            buildMirror(dir, false)
            const stale = join(dir, STAGE_ROOT, "dock", "idea", "skills", "using", "SKILL.md")
            expect(existsSync(stale)).toBe(true)

            // drop the source primitive, rebuild
            rmSync(join(dir, "source", "ripperdoc", "dock", "idea", "skills"), { recursive: true, force: true })
            buildMirror(dir, false)
            expect(existsSync(stale)).toBe(false)
        })

        it("missing source/ripperdoc/ returns empty", () => {
            expect(buildMirror(dir, false)).toEqual([])
        })

        it("dry-run writes nothing but reports the would-be set", () => {
            seedRipperdoc(dir)
            const logSpy = spyOn(console, "log").mockImplementation(() => {})
            try {
                const written = buildMirror(dir, true)
                expect(written.length).toBe(8)
            } finally {
                logSpy.mockRestore()
            }
            expect(existsSync(join(dir, STAGE_ROOT))).toBe(false)
        })
    })

    context("stampMirror", () => {
        it("sets the version of every versioned manifest to the short HEAD SHA", async () => {
            seedRipperdoc(dir)
            const written = buildMirror(dir, false)
            spawnSpy.mockImplementation(() => fakeChild("abc1234\n"))

            await stampMirror(dir, written, false)

            expect(spawnCalls()).toContainEqual(["git", "-C", dir, "describe", "--tags", "--always"])
            const stage = join(dir, STAGE_ROOT)
            // plugin.json + gemini-extension.json carry a top-level "version" -> stamped
            expect(
                JSON.parse(readFileSync(join(stage, "dock/idea/.claude-plugin/plugin.json"), "utf8")).version
            ).toBe("abc1234")
            expect(JSON.parse(readFileSync(join(stage, "dock/idea/gemini-extension.json"), "utf8")).version).toBe(
                "abc1234"
            )
            // marketplace.json has NO top-level version, but its nested plugins[].version
            // ARE the per-plugin cache keys — each is stamped to the SHA (no top-level key added).
            const market = JSON.parse(readFileSync(join(stage, "dock/.claude-plugin/marketplace.json"), "utf8"))
            expect(market.version).toBeUndefined()
            expect(market.plugins[0].version).toBe("abc1234")
        })

        it("git failure -> versions unchanged, never throws (fallback)", async () => {
            seedRipperdoc(dir)
            const written = buildMirror(dir, false)
            spawnSpy.mockImplementation(() => fakeChild("", 128, "not a git repository"))

            await stampMirror(dir, written, false)

            const v = JSON.parse(
                readFileSync(join(dir, STAGE_ROOT, "dock/idea/.claude-plugin/plugin.json"), "utf8")
            ).version
            expect(v).toBe("0.0.0") // untouched
        })

        it("spawn throw (git missing / not a repo) is swallowed", async () => {
            seedRipperdoc(dir)
            const written = buildMirror(dir, false)
            spawnSpy.mockImplementation(() => {
                throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
            })

            await stampMirror(dir, written, false) // must not reject

            const v = JSON.parse(
                readFileSync(join(dir, STAGE_ROOT, "dock/idea/gemini-extension.json"), "utf8")
            ).version
            expect(v).toBe("0.0.0") // untouched
        })

        it("dry-run is a no-op (no git spawn, no writes)", async () => {
            seedRipperdoc(dir)
            const written = buildMirror(dir, false)
            spawnSpy.mockClear()
            await stampMirror(dir, written, true)
            expect(spawnCalls()).toEqual([])
        })
    })

    context("runCli", () => {
        it("dry-run returns success without spawning", async () => {
            expect(await runCli(["echo", "test"], true)).toEqual([true, ""])
            expect(spawnCalls()).toEqual([])
        })

        it("success on exit 0", async () => {
            spawnSpy.mockImplementation(() => fakeChild())
            expect(await runCli(["claude", "x"], false)).toEqual([true, ""])
        })

        it("non-zero exit surfaces stderr, then stdout, then a default", async () => {
            spawnSpy.mockImplementation(() => fakeChild("", 1, "  boom  "))
            expect(await runCli(["claude", "x"], false)).toEqual([false, "boom"])
            spawnSpy.mockImplementation(() => fakeChild("out-only", 1))
            expect(await runCli(["claude", "x"], false)).toEqual([false, "out-only"])
            spawnSpy.mockImplementation(() => fakeChild("", 1))
            expect(await runCli(["claude", "x"], false)).toEqual([false, "non-zero exit"])
        })

        it("timeout surfaces the timed-out message (real child, tiny injected timeout)", async () => {
            // Drive runCli's REAL timeout path: spawn an actual `sleep 5` (delegate the spy
            // to the real Bun.spawn) under a tiny injected timeoutMs, so reap's real timer
            // fires fast, kills + reaps the child, and runCli surfaces the timeout message.
            // 20ms / 1000 = 0.02s, matching runCli's `timed out after ${timeoutMs / 1000}s`.
            spawnSpy.mockImplementation((...args: Parameters<typeof Bun.spawn>) => realSpawn(...args))
            const [ok, msg] = await runCli(["sleep", "5"], false, 20)
            expect(ok).toBe(false)
            expect(msg).toBe("timed out after 0.02s")
        }, 10_000)

        it("ENOENT from spawn -> '<cmd> not on PATH'", async () => {
            spawnSpy.mockImplementation(() => {
                throw Object.assign(new Error("Executable not found in $PATH"), { code: "ENOENT" })
            })
            expect(await runCli(["nonexistent-xyz", "x"], false)).toEqual([false, "nonexistent-xyz not on PATH"])
        })
    })

    context("installDeps", () => {
        it("dry-run returns ok without spawning", async () => {
            const [ok, err] = await installDeps(dir, true)
            expect(ok).toBe(true)
            expect(err).toBe("")
            expect(spawnCalls()).toEqual([])
        })

        it("runs `<bun> install --production`, ok on exit 0", async () => {
            spawnSpy.mockImplementation(() => fakeChild())
            const [ok, err] = await installDeps(dir, false)
            expect(ok).toBe(true)
            expect(err).toBe("")
            // argv[0] is the running Bun (process.execPath); assert the verb + flag.
            expect(spawnCalls()[0]?.slice(1)).toEqual(["install", "--production"])
        })

        it("non-zero exit surfaces stderr, then stdout, then a default", async () => {
            spawnSpy.mockImplementation(() => fakeChild("", 1, "  lockfile conflict  "))
            expect(await installDeps(dir, false)).toEqual([false, "lockfile conflict"])
            spawnSpy.mockImplementation(() => fakeChild("out-only", 1))
            expect(await installDeps(dir, false)).toEqual([false, "out-only"])
            spawnSpy.mockImplementation(() => fakeChild("", 1))
            expect(await installDeps(dir, false)).toEqual([false, "non-zero exit"])
        })
    })

    // registerMarketplace — command shapes
    context("registerMarketplace", () => {
        it("claude invokes the marketplace-add CLI", async () => {
            const [r] = await registerMarketplace("claude", "/some/rack", false)
            expect(r).toBe(true)
            expect(spawnCalls()).toEqual([["claude", "plugin", "marketplace", "add", "/some/rack"]])
        })

        it("codex invokes the marketplace-add CLI", async () => {
            await registerMarketplace("codex", "/some/rack", false)
            expect(spawnCalls()).toEqual([["codex", "plugin", "marketplace", "add", "/some/rack"]])
        })

        it("gemini is a no-op", async () => {
            const [r, msg] = await registerMarketplace("gemini", "/some/rack", false)
            expect([r, msg]).toEqual([true, ""])
            expect(spawnCalls()).toEqual([])
        })

        it("'already' in stderr is treated as success", async () => {
            spawnSpy.mockImplementation(() => fakeChild("", 1, "marketplace already exists"))
            const [r] = await registerMarketplace("claude", "/some/rack", false)
            expect(r).toBe(true)
        })
    })

    // refreshMarketplace — command shape
    context("refreshMarketplace", () => {
        it("invokes `plugin marketplace update <name>`", async () => {
            await refreshMarketplace("claude", "dock", false)
            expect(spawnCalls()).toEqual([["claude", "plugin", "marketplace", "update", "dock"]])
        })
    })

    // installPlugin — command shapes
    context("installPlugin", () => {
        const spec: PluginSpec = { name: "format", sourcePath: "/some/rack/format" }

        it("claude uses --scope user", async () => {
            await installPlugin("claude", spec, "chrome", false)
            expect(spawnCalls()).toEqual([["claude", "plugin", "install", "format@chrome", "--scope", "user"]])
        })

        it("codex uses the `add` verb, no --scope flag", async () => {
            await installPlugin("codex", spec, "chrome", false)
            expect(spawnCalls()).toEqual([["codex", "plugin", "add", "format@chrome"]])
        })

        it("gemini uses extensions install --path", async () => {
            await installPlugin("gemini", spec, "chrome", false)
            expect(spawnCalls()).toEqual([["gemini", "extensions", "install", "--path", "/some/rack/format"]])
        })

        it("gemini falls back to `extensions update` when already installed", async () => {
            spawnSpy.mockImplementation(() => fakeChild("", 1, "extension already installed"))
            await installPlugin("gemini", spec, "chrome", false)
            expect(spawnCalls()).toEqual([
                ["gemini", "extensions", "install", "--path", "/some/rack/format"],
                ["gemini", "extensions", "update", "format"]
            ])
        })
    })

    context("copyOverlay", () => {
        it("create, no backup", () => {
            const repoRoot = join(dir, "repo")
            const config = join(dir, "config")
            seedOverlay(repoRoot)

            const [r, err, records] = copyOverlay("claude", repoRoot, config, false)

            expect([r, err]).toEqual([true, ""])
            expect(readFileSync(join(config, "settings.json"), "utf8")).toBe('{"_": "overlay"}')
            expect(readFileSync(join(config, "agents", "fixer.md"), "utf8")).toBe("# fixer overlay")
            expect(new Set(records.map((rec) => rec.action))).toEqual(new Set(["create"]))
            expect(records.every((rec) => rec.backup === null)).toBe(true)
            for (const rec of records) {
                expect(rec.src.startsWith("/")).toBe(false) // repo-relative
                expect(rec.dst.startsWith("/")).toBe(true) // absolute
            }
        })

        it("missing root returns empty", () => {
            const repoRoot = join(dir, "repo")
            mkdirSync(repoRoot, { recursive: true })
            const config = join(dir, "config")
            expect(copyOverlay("claude", repoRoot, config, false)).toEqual([true, "", []])
        })

        it("overwrite backs up the original once at .bak", () => {
            const repoRoot = join(dir, "repo")
            const config = join(dir, "config")
            seedOverlay(repoRoot)
            mkdirSync(config, { recursive: true })
            writeFileSync(join(config, "settings.json"), '{"_": "user-original"}')

            const [r, err, records] = copyOverlay("claude", repoRoot, config, false)

            expect([r, err]).toEqual([true, ""])
            expect(readFileSync(join(config, "settings.json.bak"), "utf8")).toBe('{"_": "user-original"}')
            expect(readFileSync(join(config, "settings.json"), "utf8")).toBe('{"_": "overlay"}')
            const rec = records.find((x) => x.dst.endsWith("settings.json"))
            expect(rec?.action).toBe("overwrite")
            expect(rec?.backup).toBe(join(config, "settings.json.bak"))
        })

        it("repeat install skips re-backup for a recorded file", () => {
            const repoRoot = join(dir, "repo")
            const config = join(dir, "config")
            seedOverlay(repoRoot)
            mkdirSync(config, { recursive: true })
            writeFileSync(join(config, "settings.json"), '{"_": "user-original"}')

            const [, , records1] = copyOverlay("claude", repoRoot, config, false)
            writeManifest(repoRoot, "claude", records1, [], [], false)
            expect(readFileSync(join(config, "settings.json.bak"), "utf8")).toBe('{"_": "user-original"}')

            writeFileSync(join(repoRoot, "source", "overwrite", "claude", "settings.json"), '{"_": "overlay-v2"}')
            const [, , records2] = copyOverlay("claude", repoRoot, config, false)

            expect(readFileSync(join(config, "settings.json"), "utf8")).toBe('{"_": "overlay-v2"}')
            expect(readFileSync(join(config, "settings.json.bak"), "utf8")).toBe('{"_": "user-original"}')
            const rec = records2.find((x) => x.dst.endsWith("settings.json"))
            expect(rec?.backup).toBe(null)
            expect(rec?.action).toBe("overwrite")
        })

        it("second backup uses a timestamp suffix when .bak is taken", () => {
            const repoRoot = join(dir, "repo")
            const config = join(dir, "config")
            seedOverlay(repoRoot)
            mkdirSync(config, { recursive: true })
            writeFileSync(join(config, "settings.json"), '{"_": "user-original"}')
            writeFileSync(join(config, "settings.json.bak"), '{"_": "stale-bak"}')

            const [, , records] = copyOverlay("claude", repoRoot, config, false)

            expect(readFileSync(join(config, "settings.json.bak"), "utf8")).toBe('{"_": "stale-bak"}')
            const rec = records.find((x) => x.dst.endsWith("settings.json"))
            expect(rec?.backup).toMatch(/settings\.json\.bak\.\d+$/)
            expect(readFileSync(rec?.backup as string, "utf8")).toBe('{"_": "user-original"}')
        })

        it("dry-run writes nothing but still produces records", () => {
            const repoRoot = join(dir, "repo")
            const config = join(dir, "config")
            seedOverlay(repoRoot)
            mkdirSync(config, { recursive: true })
            writeFileSync(join(config, "settings.json"), '{"_": "user-original"}')

            const [r, err, records] = copyOverlay("claude", repoRoot, config, true)

            expect([r, err]).toEqual([true, ""])
            expect(readFileSync(join(config, "settings.json"), "utf8")).toBe('{"_": "user-original"}')
            expect(() => readFileSync(join(config, "settings.json.bak"), "utf8")).toThrow()
            expect(records.length).toBe(2)
            const rec = records.find((x) => x.dst.endsWith("settings.json"))
            expect(rec?.action).toBe("overwrite")
            expect(rec?.backup).toBe(join(config, "settings.json.bak"))
        })
    })

    context("backupPath", () => {
        it("returns .bak when free, .bak.<ts> when taken", () => {
            const target = join(dir, "x.json")
            expect(backupPath(target)).toBe(`${target}.bak`)
            writeFileSync(`${target}.bak`, "taken")
            expect(backupPath(target)).toMatch(/x\.json\.bak\.\d+$/)
        })
    })

    context("writeManifest", () => {
        it("writes schema + harness record", () => {
            const overlay = [
                {
                    dst: "/c/settings.json",
                    src: "source/overwrite/claude/settings.json",
                    backup: null,
                    action: "create" as const
                }
            ]
            writeManifest(dir, "claude", overlay, ["dock"], [{ name: "fixer" }], false)

            const data = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"))
            expect(data.schema).toBe(MANIFEST_SCHEMA)
            expect(Object.keys(data.harnesses)).toEqual(["claude"])
            expect(data.harnesses.claude.overlay).toEqual(overlay)
            expect(data.harnesses.claude.marketplaces).toEqual(["dock"])
            expect(data.harnesses.claude.plugins).toEqual([{ name: "fixer" }])
            expect("installed_at" in data.harnesses.claude).toBe(true)
        })

        it("merges across harnesses", () => {
            writeManifest(dir, "claude", [], ["dock"], [], false)
            writeManifest(dir, "gemini", [], [], [], false)
            const data = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"))
            expect(new Set(Object.keys(data.harnesses))).toEqual(new Set(["claude", "gemini"]))
        })

        it("replaces the same harness", () => {
            writeManifest(dir, "claude", [], ["dock"], [], false)
            writeManifest(dir, "claude", [], ["chrome", "dock"], [], false)
            const data = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"))
            expect(data.harnesses.claude.marketplaces).toEqual(["chrome", "dock"])
        })

        it("dry-run writes nothing", () => {
            const logSpy = spyOn(console, "log").mockImplementation(() => {})
            try {
                writeManifest(dir, "claude", [], [], [], true)
            } finally {
                logSpy.mockRestore()
            }
            expect(() => readFileSync(join(dir, MANIFEST_FILE), "utf8")).toThrow()
        })

        it("emits 2-space indent + trailing newline (schema-1 shape)", () => {
            writeManifest(dir, "claude", [], [], [], false)
            const text = readFileSync(join(dir, MANIFEST_FILE), "utf8")
            expect(text.endsWith("\n")).toBe(true)
            expect(text).toContain('\n  "schema": 1,')
        })
    })

    context("loadManifest", () => {
        it("skeleton when missing", () => {
            expect(loadManifest(dir)).toEqual({ schema: MANIFEST_SCHEMA, harnesses: {} })
        })

        it("skeleton when corrupt", () => {
            writeFileSync(join(dir, MANIFEST_FILE), "not json{")
            expect(loadManifest(dir)).toEqual({ schema: MANIFEST_SCHEMA, harnesses: {} })
        })

        it("reads valid", () => {
            const payload = { schema: 1, harnesses: { claude: { overlay: [] } } }
            writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(payload))
            expect(loadManifest(dir)).toEqual(payload)
        })
    })

    // installFor — behavior via the spawn mock (harness presence is an `onPath` spawn)
    context("installFor", () => {
        it("returns 1 when the harness is not on PATH", async () => {
            // onPath() shells out to `sh -c command -v` — make that probe fail (exit 1).
            spawnSpy.mockImplementation((cmd) => ((cmd as string[])[0] === "sh" ? fakeChild("", 1) : fakeChild()))
            const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
            const logSpy = spyOn(console, "log").mockImplementation(() => {})
            try {
                const rc = await installFor("claude", false)
                expect(rc).toBe(1)
                const wrote = errSpy.mock.calls.map((c) => String(c[0])).join("")
                expect(wrote).toContain("not on PATH")
            } finally {
                logSpy.mockRestore()
                errSpy.mockRestore()
            }
        })

        it("dry-run returns 0 (harness present, no real subprocess work)", async () => {
            // onPath probe succeeds; in dry-run copyOverlay/writeManifest write
            // nothing, so this is safe to run against the real REPO_ROOT / $HOME.
            spawnSpy.mockImplementation(() => fakeChild())
            const logSpy = spyOn(console, "log").mockImplementation(() => {})
            try {
                const rc = await installFor("claude", true)
                expect(rc).toBe(0)
            } finally {
                logSpy.mockRestore()
            }
        })

        // NOTE: the marketplace-failure path (-> rc 1) is NOT unit-tested here. With
        // dryRun=false, installFor's copyOverlay writes the real overlay into $HOME and
        // writeManifest writes the real repo's .install-manifest.json — destructive side
        // effects with no clean seam to stub for install.ts's own self-calls. The path
        // is covered by the golden-diff dry-run and the registerMarketplace unit tests
        // above.
    })

    // parseInstallArgs — exit-code behavior (process.exit seam)
    context("parseInstallArgs", () => {
        function captureExit(fn: () => void): { code: number | null; stderr: string } {
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

        it("parses harness + --dry-run", () => {
            expect(parseInstallArgs(["claude", "--dry-run"])).toEqual({ harnesses: ["claude"], dryRun: true })
            expect(parseInstallArgs(["gemini"])).toEqual({ harnesses: ["gemini"], dryRun: false })
        })

        it("no positionals -> empty harnesses (auto-detect), no exit", () => {
            expect(parseInstallArgs([])).toEqual({ harnesses: [], dryRun: false })
            expect(parseInstallArgs(["--dry-run"])).toEqual({ harnesses: [], dryRun: true })
        })

        it("accepts multiple explicit harnesses, in argv order", () => {
            expect(parseInstallArgs(["gemini", "claude"])).toEqual({ harnesses: ["gemini", "claude"], dryRun: false })
        })

        it("invalid harness choice -> exit 2", () => {
            const { code, stderr } = captureExit(() => parseInstallArgs(["bogus"]))
            expect(code).toBe(2)
            expect(stderr).toContain("invalid choice: 'bogus'")
        })

        it("unknown option -> exit 2", () => {
            const { code, stderr } = captureExit(() => parseInstallArgs(["claude", "--nope"]))
            expect(code).toBe(2)
            expect(stderr).toContain("install.ts:")
        })
    })
})
