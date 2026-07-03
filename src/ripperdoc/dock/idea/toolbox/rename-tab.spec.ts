/**
 * rename-tab.spec.ts — the CLI at two layers.
 *
 * UNIT (hermetic): slugifyTabName is checked directly, and renameTabCli is driven
 * with a fake key/pids/store/rename seam (DI) so NO real IDE dispatch or fs write
 * happens — asserting the sanitize -> setSavedName -> rename wiring, the reset path
 * (clearSavedName + clear title), and the empty-after-sanitize no-op.
 *
 * E2E (subprocess): every case runs under --dry-run so effect() resolves the tab's
 * pids but SKIPS the real IDE dispatch, and against a throwaway $HOME so the
 * un-gated saved-name write can never touch the real ~/.preemdeck. We assert the
 * exit code, clean stdout, and the --verbose decision line (now the sanitized slug)
 * for each name mode, plus the assertIdea gate. Mirrors tab-title.spec's harness.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { type RenameTabCliDeps, renameTabCli, slugifyTabName } from "./rename-tab"

const context = describe

// A fake seam set: canned key + pids, and recorders for the store + rename calls.
const fakeDeps = (
    over: { key?: string; pids?: number[] } = {}
): {
    deps: RenameTabCliDeps
    calls: {
        set: { key: string; slug: string }[]
        clear: string[]
        rename: { name: string | null; pids: number[] }[]
    }
} => {
    const calls = {
        set: [] as { key: string; slug: string }[],
        clear: [] as string[],
        rename: [] as { name: string | null; pids: number[] }[]
    }
    const deps: RenameTabCliDeps = {
        tabKey: () => Promise.resolve(over.key ?? "ttys006"),
        resolveTabPids: () => Promise.resolve(over.pids ?? [111, 222]),
        setSavedName: (key, slug) => {
            calls.set.push({ key, slug })
        },
        clearSavedName: (key) => {
            calls.clear.push(key)
        },
        renameTab: (name, pids) => {
            calls.rename.push({ name, pids: [...pids] })
            return Promise.resolve()
        }
    }
    return { deps, calls }
}

let home = ""
beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "preemdeck-renametab-"))
})
afterEach(async () => {
    await rm(home, { recursive: true, force: true })
})

// Spawn the CLI. PREEMDECK_FORCE_IN_IDEA=1 lets assertIdea() pass in CI; --dry-run
// makes effect() skip the IDE write; HOME=<throwaway> quarantines the saved-name write.
const run = async (
    args: string[],
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "rename-tab.ts"), ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: home, PREEMDECK_FORCE_IN_IDEA: "1", ...environment }
    })
    const [stdout, stderr] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text()
    ])
    const code = await subprocess.exited
    return { code, stdout, stderr }
}

describe("slugifyTabName", () => {
    it.each([
        ["PR Review", "pr-review"],
        ["  Tab Naming  ", "tab-naming"],
        ['"quoted"', "quoted"],
        ["`backtick`", "backtick"],
        ["Fix: the CI!!!", "fix-the-ci"],
        ["already-kebab", "already-kebab"],
        ["UPPER CASE", "upper-case"],
        ["multi\nline\nname", "multi"]
    ] as [string, string][])("sanitizes %p -> %p", (raw, slug) => {
        expect(slugifyTabName(raw)).toBe(slug)
    })

    it("returns '' for junk-only input (the caller no-ops)", () => {
        expect(slugifyTabName("!!! ???")).toBe("")
        expect(slugifyTabName("   ")).toBe("")
    })

    it("strips control characters", () => {
        expect(slugifyTabName("a\u0000b\u001fc")).toBe("abc")
    })

    it("caps the slug at 24 chars", () => {
        expect(slugifyTabName("a".repeat(40))).toBe("a".repeat(24))
    })

    it("re-trims a trailing hyphen the length cap can expose", () => {
        // 23 'a's + " b" -> "aaa…(23)-b" -> slice(0,24) leaves "aaa…(23)-" -> re-trimmed.
        expect(slugifyTabName(`${"a".repeat(23)} b`)).toBe("a".repeat(23))
    })
})

describe("renameTabCli (unit, DI seams)", () => {
    it("sanitizes the name, persists the slug, and renames to it", async () => {
        const { deps, calls } = fakeDeps({ key: "ttys006", pids: [42] })
        await renameTabCli("PR Review!", false, deps)
        expect(calls.set).toEqual([{ key: "ttys006", slug: "pr-review" }])
        expect(calls.rename).toEqual([{ name: "pr-review", pids: [42] }])
        expect(calls.clear).toEqual([])
    })

    it("still persists the slug when no pid resolves, so a later tab-title picks it up", async () => {
        const { deps, calls } = fakeDeps({ key: "work", pids: [] })
        await renameTabCli("Tab Naming", false, deps)
        expect(calls.set).toEqual([{ key: "work", slug: "tab-naming" }])
        expect(calls.rename).toEqual([{ name: "tab-naming", pids: [] }])
    })

    it("reset (null) clears the saved name and clears the title", async () => {
        const { deps, calls } = fakeDeps({ key: "work", pids: [7] })
        await renameTabCli(null, false, deps)
        expect(calls.clear).toEqual(["work"])
        expect(calls.rename).toEqual([{ name: null, pids: [7] }])
        expect(calls.set).toEqual([])
    })

    it("is a full no-op for a name that sanitizes to empty (no persist, no rename)", async () => {
        const { deps, calls } = fakeDeps()
        await renameTabCli("!!! ???", false, deps)
        expect(calls.set).toEqual([])
        expect(calls.rename).toEqual([])
        expect(calls.clear).toEqual([])
    })
})

describe("rename-tab CLI (e2e, subprocess)", () => {
    context("on a live IDE, under --dry-run (no IDE write)", () => {
        it("takes the rename path for a real name: exits 0, stdout empty", async () => {
            const { code, stdout } = await run(["--dry-run", "PR review"])
            expect(code).toBe(0)
            expect(stdout).toBe("")
        })

        it("stays silent on stderr without --verbose", async () => {
            const { code, stderr } = await run(["--dry-run", "PR review"])
            expect(code).toBe(0)
            expect(stderr).toBe("")
        })

        it("reports the SANITIZED slug on stderr under --verbose", async () => {
            const { code, stderr } = await run(["--dry-run", "--verbose", "PR review"])
            expect(code).toBe(0)
            expect(stderr).toContain("name=pr-review")
        })

        it.each([
            ["--reset flag", ["--dry-run", "--verbose", "--reset"]],
            ["an omitted name", ["--dry-run", "--verbose"]]
        ] as [string, string[]][])("takes the reset path for %s", async (_label, args) => {
            const { code, stderr } = await run(args)
            expect(code).toBe(0)
            expect(stderr).toContain("reset (restore auto-naming)")
        })

        it.each([
            ["--reset", ["--dry-run", "--reset"]],
            ["a blank name", ["--dry-run", ""]],
            ["an omitted name", ["--dry-run"]]
        ] as [string, string[]][])("exits 0 with empty stdout for %s", async (_label, args) => {
            const { code, stdout } = await run(args)
            expect(code).toBe(0)
            expect(stdout).toBe("")
        })
    })

    context("the assertIdea gate", () => {
        it("exits non-zero with the IdeaError on stderr when the JetBrains env is unset", async () => {
            const { code, stdout, stderr } = await run(["--dry-run", "PR review"], {
                __CFBundleIdentifier: "",
                TERMINAL_EMULATOR: "",
                PREEMDECK_FORCE_IN_IDEA: "0"
            })
            expect(code).not.toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toContain("no JetBrains IDE in the process ancestry")
        })
    })

    context("with --help", () => {
        it("exits 0 and prints usage to stdout", async () => {
            const { code, stdout } = await run(["--help"])
            expect(code).toBe(0)
            expect(stdout).toContain("rename-tab")
        })
    })
})
