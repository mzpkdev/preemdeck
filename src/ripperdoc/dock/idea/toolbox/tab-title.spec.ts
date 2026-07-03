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
import { applyTitle, runRename, type TabTitleDeps, tabName } from "./tab-title"

const context = describe

const env = (extra: Record<string, string>): NodeJS.ProcessEnv => extra as NodeJS.ProcessEnv

// A fake seam set: canned inIdea/pids/key/saved-name, a renameTab that records its
// calls, and a clearSavedName recorder (for the reset path).
const fakeDeps = (
    over: { inIdea?: boolean; pids?: number[]; saved?: string; key?: string } = {}
): { deps: TabTitleDeps; calls: { name: string | null; pids: number[] }[]; cleared: string[] } => {
    const calls: { name: string | null; pids: number[] }[] = []
    const cleared: string[] = []
    const deps: TabTitleDeps = {
        inIdea: () => over.inIdea ?? true,
        resolveTabPids: () => Promise.resolve(over.pids ?? [111, 222]),
        renameTab: (name, pids) => {
            calls.push({ name, pids: [...pids] })
            return Promise.resolve()
        },
        tabKey: () => Promise.resolve(over.key ?? "ttys006"),
        getSavedName: () => over.saved,
        clearSavedName: (key) => {
            cleared.push(key)
        }
    }
    return { deps, calls, cleared }
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

    context("the saved name (the model's chosen tab name) as the label base", () => {
        it("prefers the saved name over the project label for a glyph flip", async () => {
            const { deps, calls } = fakeDeps({ pids: [9], saved: "tab-naming" })
            expect(await applyTitle("busy", env({ CLAUDE_PROJECT_DIR: "/a/proj" }), deps)).toBe(true)
            // ⚡ tab-naming, NOT ⚡ proj — the model's name survives the state flip.
            expect(calls).toEqual([{ name: windowName("busy", "tab-naming"), pids: [9] }])
        })

        it("falls back to the project label when nothing is saved", async () => {
            const { deps, calls } = fakeDeps({ pids: [9] })
            await applyTitle("idle", env({ CLAUDE_PROJECT_DIR: "/a/proj" }), deps)
            expect(calls).toEqual([{ name: windowName("idle", "proj"), pids: [9] }])
        })

        it("clears the saved name for this tab's key on reset (then restores auto-naming)", async () => {
            const { deps, calls, cleared } = fakeDeps({ pids: [7], key: "work", saved: "tab-naming" })
            expect(await applyTitle("reset", env({ CLAUDE_PROJECT_DIR: "/a/proj" }), deps)).toBe(true)
            expect(cleared).toEqual(["work"])
            expect(calls).toEqual([{ name: null, pids: [7] }])
        })

        it("does NOT clear the saved name on a non-reset state", async () => {
            const { deps, cleared } = fakeDeps({ saved: "tab-naming" })
            await applyTitle("busy", env({ CLAUDE_PROJECT_DIR: "/a/proj" }), deps)
            expect(cleared).toEqual([])
        })
    })

    context("runRename — the real effect()-gated dispatch seam", () => {
        it("is a no-op that never throws for empty pids (core short-circuits before any IDE contact)", async () => {
            await expect(runRename(null, [])).resolves.toBeUndefined()
            await expect(runRename("⚡ proj", [])).resolves.toBeUndefined()
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
