/**
 * tab-title.spec.ts — exercises tab-title.ts at two layers.
 *
 * UNIT (hermetic, no real IDE): the pure name builder is checked directly, and
 * applyTitle is driven with an injected env + a fake inIdea / resolveTabPids /
 * renameTab seam (DI), so NO real IDE dispatch ever happens. runRename (the real
 * effect()-gated seam) is exercised only for the empty-pids no-op, which core
 * short-circuits before any IDE contact.
 *
 * E2E (subprocess): spawn tab-title.ts under --dry-run so effect() skips the real
 * renameTab write — the process exits 0 and, critically, writes NOTHING to stdout
 * (a SessionStart/UserPromptSubmit hook's stdout is fed back to the model as
 * context). The in-IDE gate is forced with PREEMDECK_FORCE_IN_IDEA; --dry-run means
 * even a WebStorm running on the dev box is never touched. Mirrors
 * tmux-title.spec / turn-notify.spec subprocess harnesses.
 */

import { describe, expect, it } from "bun:test"
import * as path from "node:path"
import { GLYPH, windowName } from "../../tmux/toolbox/tmux-title"
import { applyTitle, effectiveState, runRename, type TabTitleDeps, tabName } from "./tab-title"

const context = describe

const env = (extra: Record<string, string>): NodeJS.ProcessEnv => extra as NodeJS.ProcessEnv

// A fake seam set: canned inIdea/pids and the tab's current title (what readTabTitle
// returns), plus a renameTab that records its calls.
const fakeDeps = (
    over: { inIdea?: boolean; pids?: number[]; current?: string | null } = {}
): { deps: TabTitleDeps; calls: { name: string | null; pids: number[] }[] } => {
    const calls: { name: string | null; pids: number[] }[] = []
    const deps: TabTitleDeps = {
        inIdea: () => over.inIdea ?? true,
        resolveTabPids: () => Promise.resolve(over.pids ?? [111, 222]),
        renameTab: (name, pids) => {
            calls.push({ name, pids: [...pids] })
            return Promise.resolve()
        },
        readTabTitle: () => Promise.resolve(over.current ?? null)
    }
    return { deps, calls }
}

// Spawn the CLI as a real subprocess. --dry-run makes effect() skip the real IDE write.
const run = async (
    args: string[],
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "tab-title.ts"), ...args], {
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

describe("tab-title", () => {
    context("tabName — the pure rename-target builder (reuses tmux-title's windowName)", () => {
        it("targets the glyph + project name for a known state", () => {
            expect(tabName("busy", "proj")).toEqual({ name: windowName("busy", "proj") })
            expect(tabName("idle", "proj")).toEqual({ name: windowName("idle", "proj") })
            expect(tabName("waiting", "proj")).toEqual({ name: windowName("waiting", "proj") })
        })
        it("is the bare glyph name when the project is unknown", () => {
            expect(tabName("idle", "")).toEqual({ name: GLYPH.idle as string })
        })
        it("clears the title on reset ({ name: null })", () => {
            expect(tabName("reset", "proj")).toEqual({ name: null })
        })
        it("is null for an unknown state (a no-op) — distinct from reset's { name: null }", () => {
            expect(tabName("bogus", "proj")).toBeNull()
        })
    })

    context("applyTitle — gated by inIdea, dispatched through the rename seam", () => {
        it("is a no-op outside a JetBrains terminal (inIdea false)", async () => {
            const { deps, calls } = fakeDeps({ inIdea: false })
            expect(await applyTitle("idle", env({ CLAUDE_PROJECT_DIR: "/a/proj" }), deps)).toBe(false)
            expect(calls.length).toBe(0)
        })
        it("renames the pid-matched tab to windowName inside a JetBrains terminal", async () => {
            const { deps, calls } = fakeDeps({ pids: [42, 43] })
            const result = await applyTitle("busy", env({ CLAUDE_PROJECT_DIR: "/a/proj" }), deps)
            expect(result).toBe(true)
            expect(calls).toEqual([{ name: windowName("busy", "proj"), pids: [42, 43] }])
        })
        it("clears the title on reset (renameTab called with null)", async () => {
            const { deps, calls } = fakeDeps({ pids: [7] })
            expect(await applyTitle("reset", env({ CLAUDE_PROJECT_DIR: "/a/proj" }), deps)).toBe(true)
            expect(calls).toEqual([{ name: null, pids: [7] }])
        })
        it("is a no-op for an unknown state even inside a terminal", async () => {
            const { deps, calls } = fakeDeps({})
            expect(await applyTitle("bogus", env({ CLAUDE_PROJECT_DIR: "/a/proj" }), deps)).toBe(false)
            expect(calls.length).toBe(0)
        })
        it("is a no-op when no pid resolves on this tab's tty (empty pids)", async () => {
            const { deps, calls } = fakeDeps({ pids: [] })
            expect(await applyTitle("idle", env({ CLAUDE_PROJECT_DIR: "/a/proj" }), deps)).toBe(false)
            expect(calls.length).toBe(0)
        })
    })

    context("the tab's own current title (read back) as the label base", () => {
        it("recovers the base from the current glyph'd title so the name survives the flip", async () => {
            const { deps, calls } = fakeDeps({ pids: [9], current: windowName("idle", "tab-naming") })
            expect(await applyTitle("busy", env({ CLAUDE_PROJECT_DIR: "/a/proj" }), deps)).toBe(true)
            // ◦ tab-naming read back, stripped to "tab-naming", re-flipped to • tab-naming (NOT • proj).
            expect(calls).toEqual([{ name: windowName("busy", "tab-naming"), pids: [9] }])
        })

        it("preserves an IDE-menu name that has no glyph (just adds the glyph)", async () => {
            const { deps, calls } = fakeDeps({ pids: [9], current: "hand-named" })
            await applyTitle("busy", env({ CLAUDE_PROJECT_DIR: "/a/proj" }), deps)
            expect(calls).toEqual([{ name: windowName("busy", "hand-named"), pids: [9] }])
        })

        it("falls back to the project label when the current title is null/unreadable", async () => {
            const { deps, calls } = fakeDeps({ pids: [9], current: null })
            await applyTitle("idle", env({ CLAUDE_PROJECT_DIR: "/a/proj" }), deps)
            expect(calls).toEqual([{ name: windowName("idle", "proj"), pids: [9] }])
        })

        it("does NOT read the title on reset (just clears, restoring auto-naming)", async () => {
            let reads = 0
            const base = fakeDeps({ pids: [7], current: "whatever" })
            const deps = {
                ...base.deps,
                readTabTitle: () => {
                    reads++
                    return Promise.resolve("whatever")
                }
            }
            expect(await applyTitle("reset", env({ CLAUDE_PROJECT_DIR: "/a/proj" }), deps)).toBe(true)
            expect(base.calls).toEqual([{ name: null, pids: [7] }])
            expect(reads).toBe(0)
        })
    })

    context("runRename — the real effect()-gated dispatch seam", () => {
        it("is a no-op that never throws for empty pids (core short-circuits before any IDE contact)", async () => {
            await expect(runRename(null, [])).resolves.toBeUndefined()
            await expect(runRename(windowName("busy", "proj"), [])).resolves.toBeUndefined()
        })
    })

    context("effectiveState — downgrades the idle Notification ping to idle", () => {
        const idle = (): Promise<Record<string, unknown>> =>
            Promise.resolve({ message: "Claude is waiting for your input" })
        const gate = (): Promise<Record<string, unknown>> =>
            Promise.resolve({ message: "Claude needs your permission to use Bash" })

        it.each(["idle", "busy", "reset", "bogus"])("passes %p through without reading stdin", async (state) => {
            let reads = 0
            const out = await effectiveState(state, () => {
                reads++
                return Promise.resolve({})
            })
            expect(out).toBe(state)
            expect(reads).toBe(0) // only "waiting" inspects the payload
        })

        it('downgrades "waiting" to "idle" for the idle "waiting for your input" ping', async () => {
            expect(await effectiveState("waiting", idle)).toBe("idle")
        })

        it('keeps "waiting" for a real permission gate', async () => {
            expect(await effectiveState("waiting", gate)).toBe("waiting")
        })

        it('keeps "waiting" when the payload is empty / unreadable', async () => {
            expect(await effectiveState("waiting", () => Promise.resolve({}))).toBe("waiting")
        })
    })

    context("CLI e2e — never pollutes stdout, always exits 0", () => {
        it("exits 0 with empty stdout inside a JetBrains terminal (--dry-run skips the IDE write)", async () => {
            const { code, stdout, stderr } = await run(["--dry-run", "busy"], { PREEMDECK_FORCE_IN_IDEA: "1" })
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })
        it("exits 0 with empty stdout outside a JetBrains terminal", async () => {
            const { code, stdout, stderr } = await run(["idle"], { PREEMDECK_FORCE_IN_IDEA: "0" })
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })
        it("exits 0 with empty stdout for an unknown state (inside, --dry-run)", async () => {
            const { code, stdout } = await run(["--dry-run", "bogus"], { PREEMDECK_FORCE_IN_IDEA: "1" })
            expect(code).toBe(0)
            expect(stdout).toBe("")
        })
    })
})
