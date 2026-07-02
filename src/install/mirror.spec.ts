/**
 * mirror.spec.ts — primitives-only mirror suite (allowlist + build + stamp).
 *
 * A tmp mkdtemp fixture backs the real-FS build; `spyOn(Bun, "spawn")` serves a canned
 * `git describe` child for the stamp cases.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { STAGE_ROOT } from "./constants"
import { buildMirror, isMirroredPrimitive, stampMirror } from "./mirror"
import { fakeChild, seedRipperdoc, silenceLog, walkRel } from "./testkit"

const context = describe

let spawnSpy: ReturnType<typeof spyOn<typeof Bun, "spawn">>
const spawnCalls = (): string[][] => spawnSpy.mock.calls.map((c) => c[0] as string[])

let dir = ""

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "preemdeck-mirror-"))
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => fakeChild())
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    spawnSpy.mockRestore()
})

describe("mirror", () => {
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
            rmSync(join(dir, "src", "ripperdoc", "dock", "idea", "skills"), { recursive: true, force: true })
            buildMirror(dir, false)
            expect(existsSync(stale)).toBe(false)
        })

        it("missing src/ripperdoc/ returns empty", () => {
            expect(buildMirror(dir, false)).toEqual([])
        })

        it("dry-run writes nothing but reports the would-be set", () => {
            seedRipperdoc(dir)
            const logSpy = silenceLog()
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
            expect(JSON.parse(readFileSync(join(stage, "dock/idea/.claude-plugin/plugin.json"), "utf8")).version).toBe(
                "abc1234"
            )
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

            const v = JSON.parse(readFileSync(join(dir, STAGE_ROOT, "dock/idea/gemini-extension.json"), "utf8")).version
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
})
