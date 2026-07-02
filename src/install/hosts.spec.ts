/**
 * hosts.spec.ts — host-CLI adapter suite (runCli/register/refresh/install + detect/read).
 *
 * Seams: a per-call `fakeChild()` served through `spyOn(Bun, "spawn")` stands in for real
 * children; the runCli timeout test delegates the spy to the real Bun.spawn (a real `sleep`)
 * under a tiny injected timeoutMs so reap's real timer fires fast. A tmp mkdtemp fixture
 * backs the real-FS cases.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { CONFIG_DIRNAMES } from "./constants"
import {
    configDir,
    detectHarnesses,
    installPlugin,
    manifestDir,
    type PluginSpec,
    readPluginSpecs,
    refreshMarketplace,
    registerMarketplace,
    runCli
} from "./hosts"
import { fakeChild, realSpawn } from "./testkit"

const context = describe

let spawnSpy: ReturnType<typeof spyOn<typeof Bun, "spawn">>
const spawnCalls = (): string[][] => spawnSpy.mock.calls.map((c) => c[0] as string[])

let dir = ""

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "preemdeck-hosts-"))
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => fakeChild())
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    spawnSpy.mockRestore()
})

describe("hosts", () => {
    context("manifestDir", () => {
        it.each([
            ["claude", ".claude-plugin"],
            ["codex", ".agents/plugins"]
        ] as ["claude" | "codex", string][])("%s -> %s", (harness, expected) =>
            expect(manifestDir(harness)).toBe(expected))
    })

    context("configDir", () => {
        // NOTE: configDir joins os.homedir() (not process.env.HOME). Bun's os.homedir()
        // snapshots $HOME at process startup on POSIX, so a runtime process.env.HOME
        // mutation is NOT observable here. Assert against the live homedir.
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
        // configDir() resolves against os.homedir() (snapshotted, un-fakeable mid-process),
        // so inject a resolver pointing at the tmp fixture instead of mutating $HOME.
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
            writeFileSync(join(md, "marketplace.json"), typeof payload === "string" ? payload : JSON.stringify(payload))
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
            spawnSpy.mockImplementation(((...args: Parameters<typeof Bun.spawn>) => realSpawn(...args)) as never)
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

    context("refreshMarketplace", () => {
        it("invokes `plugin marketplace update <name>`", async () => {
            await refreshMarketplace("claude", "dock", false)
            expect(spawnCalls()).toEqual([["claude", "plugin", "marketplace", "update", "dock"]])
        })
    })

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

        it("gemini installs from a positional source with --consent --skip-settings", async () => {
            await installPlugin("gemini", spec, "chrome", false)
            expect(spawnCalls()).toEqual([
                ["gemini", "extensions", "install", "/some/rack/format", "--consent", "--skip-settings"]
            ])
        })

        it("gemini falls back to `extensions update` when already installed", async () => {
            spawnSpy.mockImplementation(() => fakeChild("", 1, "extension already installed"))
            await installPlugin("gemini", spec, "chrome", false)
            expect(spawnCalls()).toEqual([
                ["gemini", "extensions", "install", "/some/rack/format", "--consent", "--skip-settings"],
                ["gemini", "extensions", "update", "format"]
            ])
        })
    })
})
