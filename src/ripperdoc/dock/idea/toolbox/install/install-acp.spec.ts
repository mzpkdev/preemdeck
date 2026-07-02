/**
 * install-acp.spec.ts — exercises install-acp.ts at two layers.
 *
 * UNIT (hermetic): the pure parse + merge/strip core, checked directly.
 *
 * E2E (subprocess): run install-acp.ts against a throwaway $HOME with a fake `npx`
 * prepended to PATH, so the pinned command is deterministic. Asserts apply →
 * idempotent re-run → restore, and that other keys survive.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    ACP_ARGS,
    AGENT_NAME,
    acpPath,
    buildEntry,
    currentCommand,
    parseConfig,
    stripClaudeCode,
    upsertClaudeCode
} from "./install-acp"

const context = describe

const temps: string[] = []
const mkTemp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "pd-acp-"))
    temps.push(dir)
    return dir
}
afterEach(() => {
    while (temps.length > 0) {
        rmSync(temps.pop() as string, { recursive: true, force: true })
    }
})

// A throwaway $HOME plus a fake `npx` on PATH, so Bun.which("npx") is deterministic.
const setupHome = (): { home: string; npx: string; path: string } => {
    const home = mkTemp()
    const bin = mkTemp()
    const npx = join(bin, "npx")
    writeFileSync(npx, "#!/bin/sh\necho fake-npx\n")
    chmodSync(npx, 0o755)
    return { home, npx, path: `${bin}:${process.env.PATH}` }
}

const run = async (args: string[], home: string, path: string): Promise<{ code: number; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, join(import.meta.dir, "install-acp.ts"), ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: home, PATH: path }
    })
    const stderr = await new Response(subprocess.stderr).text()
    const code = await subprocess.exited
    return { code, stderr }
}

describe("install-acp", () => {
    context("pure helpers", () => {
        it("acpPath is ~/.jetbrains/acp.json", () => {
            expect(acpPath("/home/me")).toBe("/home/me/.jetbrains/acp.json")
        })
        it("buildEntry pins command with fixed args and empty env", () => {
            expect(buildEntry("/n/npx")).toEqual({ command: "/n/npx", args: [...ACP_ARGS], env: {} })
        })
        it("parseConfig is {} for empty, invalid, or non-object JSON", () => {
            expect(parseConfig(null)).toEqual({})
            expect(parseConfig("   ")).toEqual({})
            expect(parseConfig("not json")).toEqual({})
            expect(parseConfig("[1,2]")).toEqual({})
            expect(parseConfig('{"a":1}')).toEqual({ a: 1 })
        })
        it("currentCommand reads the entry command, else null", () => {
            expect(currentCommand({ agent_servers: { [AGENT_NAME]: { command: "/x" } } })).toBe("/x")
            expect(currentCommand({})).toBeNull()
            expect(currentCommand({ agent_servers: [] })).toBeNull()
        })
    })

    context("upsertClaudeCode", () => {
        it("adds the entry to an empty config", () => {
            const { config, previous, changed } = upsertClaudeCode({}, "/n/npx")
            expect(changed).toBe(true)
            expect(previous).toBeNull()
            expect((config.agent_servers as Record<string, unknown>)[AGENT_NAME]).toEqual(buildEntry("/n/npx"))
        })
        it("is idempotent when the command already matches", () => {
            const first = upsertClaudeCode({}, "/n/npx").config
            const { changed, previous } = upsertClaudeCode(first, "/n/npx")
            expect(changed).toBe(false)
            expect(previous).toBe("/n/npx")
        })
        it("rewrites a stale command and preserves other keys", () => {
            const before = {
                top: "keep",
                agent_servers: { Other: { command: "/other" }, [AGENT_NAME]: { command: "/old/npx" } }
            }
            const { config, previous, changed } = upsertClaudeCode(before, "/new/npx")
            expect(changed).toBe(true)
            expect(previous).toBe("/old/npx")
            const servers = config.agent_servers as Record<string, unknown>
            expect((servers[AGENT_NAME] as { command: string }).command).toBe("/new/npx")
            expect(servers.Other).toEqual({ command: "/other" })
            expect(config.top).toBe("keep")
        })
        it("treats a malformed agent_servers as empty", () => {
            const { config, changed } = upsertClaudeCode({ agent_servers: "nope" }, "/n/npx")
            expect(changed).toBe(true)
            expect((config.agent_servers as Record<string, unknown>)[AGENT_NAME]).toEqual(buildEntry("/n/npx"))
        })
    })

    context("stripClaudeCode", () => {
        it("removes the entry and drops an emptied agent_servers", () => {
            const before = upsertClaudeCode({}, "/n/npx").config
            const { config, changed } = stripClaudeCode(before)
            expect(changed).toBe(true)
            expect(config.agent_servers).toBeUndefined()
        })
        it("keeps other agent servers", () => {
            const before = { agent_servers: { Other: { command: "/o" }, [AGENT_NAME]: { command: "/n" } } }
            const { config } = stripClaudeCode(before)
            expect(config.agent_servers).toEqual({ Other: { command: "/o" } })
        })
        it("is a no-op when the entry is absent", () => {
            expect(stripClaudeCode({ agent_servers: {} }).changed).toBe(false)
            expect(stripClaudeCode({}).changed).toBe(false)
        })
    })

    context("CLI e2e", () => {
        it("creates, is idempotent, then restores (surgical, no .bak)", async () => {
            const { home, npx, path } = setupHome()
            const file = acpPath(home)

            const applied = await run([], home, path)
            expect(applied.code).toBe(0)
            const config = parseConfig(readFileSync(file, "utf8"))
            expect(currentCommand(config)).toBe(npx)

            const again = await run([], home, path)
            expect(again.stderr).toContain("already pins npx")

            const restored = await run(["--restore"], home, path)
            expect(restored.code).toBe(0)
            expect(parseConfig(readFileSync(file, "utf8")).agent_servers).toBeUndefined()
        })

        it("preserves existing keys, backs up, and restores from .bak", async () => {
            const { home, npx, path } = setupHome()
            const file = acpPath(home)
            mkdirSync(join(home, ".jetbrains"), { recursive: true })
            const seed = `${JSON.stringify({ agent_servers: { Other: { command: "/o" } }, top: "keep" }, null, 2)}\n`
            writeFileSync(file, seed)

            await run([], home, path)
            const config = parseConfig(readFileSync(file, "utf8"))
            expect(currentCommand(config)).toBe(npx)
            expect((config.agent_servers as Record<string, unknown>).Other).toEqual({ command: "/o" })
            expect(config.top).toBe("keep")
            expect(readFileSync(`${file}.bak`, "utf8")).toBe(seed)

            const restored = await run(["--restore"], home, path)
            expect(restored.code).toBe(0)
            expect(readFileSync(file, "utf8")).toBe(seed)
        })
    })
})
