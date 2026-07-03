import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { IdeaError } from "./errors"
import {
    bundleToBasename,
    filterExecsForLaunchingProduct,
    inIdea,
    type PsList,
    type PsProbe,
    resolveExecPath,
    resolveExecPaths,
    resolveLogDir
} from "./idea-mac"

const context = describe

const WEBSTORM = "/Applications/WebStorm.app/Contents/MacOS/webstorm"

// Real ancestry observed under WebStorm: pid -> (ppid, exe).
// The leaf is the toolbox's own Bun runtime — a non-IDE binary that must be skipped.
const ANCESTRY: Record<number, [number, string]> = {
    7539: [7537, "/Users/dev/.preemdeck/.runtime/bin/bun"],
    7537: [81159, "/bin/zsh"],
    81159: [24643, "claude"],
    24643: [57130, "/bin/zsh"],
    57130: [1, WEBSTORM]
}

// A chain with no JetBrains binary: zsh -> launchd -> pid 1.
const NO_IDE: Record<number, [number, string]> = {
    4242: [4241, "/bin/zsh"],
    4241: [1, "/sbin/launchd"]
}

/** Build a PsProbe keyed off the pid (async seam). */
const fakeProbe = (ancestry: Record<number, [number, string]>): PsProbe => {
    return async (pid) => {
        const entry = ancestry[pid]
        if (entry === undefined) {
            return null // unknown pid -> ps yields <2 fields -> break
        }
        return { ppid: entry[0], exe: entry[1] }
    }
}

describe("idea (mac)", () => {
    context("inIdea", () => {
        const saved = { bundle: process.env.__CFBundleIdentifier, term: process.env.TERMINAL_EMULATOR }
        afterEach(() => {
            // Restore the real env after each toggle.
            if (saved.bundle === undefined) delete process.env.__CFBundleIdentifier
            else process.env.__CFBundleIdentifier = saved.bundle
            if (saved.term === undefined) delete process.env.TERMINAL_EMULATOR
            else process.env.TERMINAL_EMULATOR = saved.term
        })

        it("true via the JetBrains bundle id", () => {
            process.env.__CFBundleIdentifier = "com.jetbrains.WebStorm"
            delete process.env.TERMINAL_EMULATOR
            expect(inIdea()).toBe(true)
        })

        it("true via the JediTerm terminal emulator", () => {
            delete process.env.__CFBundleIdentifier
            process.env.TERMINAL_EMULATOR = "JetBrains-JediTerm"
            expect(inIdea()).toBe(true)
        })

        it("false when neither is set", () => {
            delete process.env.__CFBundleIdentifier
            delete process.env.TERMINAL_EMULATOR
            expect(inIdea()).toBe(false)
        })
    })

    context("resolveExecPath", () => {
        it("walks the ancestry to WebStorm", async () => {
            expect(await resolveExecPath(fakeProbe(ANCESTRY), 7539)).toBe(WEBSTORM)
        })

        it("skips the non-IDE leaf (the Bun runtime)", async () => {
            expect(await resolveExecPath(fakeProbe(ANCESTRY), 7539)).not.toContain(".runtime/bin/bun")
        })

        it("throws IdeaError when no JetBrains binary is in the chain", async () => {
            await expect(resolveExecPath(fakeProbe(NO_IDE), 4242)).rejects.toThrow(IdeaError)
        })

        it("stops the climb at a dead/exited pid (probe returns null)", async () => {
            // A probe that always reports "no such process" -> no IDE found -> IdeaError.
            await expect(resolveExecPath(async () => null, 999)).rejects.toThrow(IdeaError)
        })
    })

    context("resolveExecPaths", () => {
        const PYCHARM = "/Applications/PyCharm.app/Contents/MacOS/pycharm"
        const fakeList =
            (paths: string[]): PsList =>
            async () =>
                paths

        it("keeps every distinct running JetBrains launcher, skipping non-IDE procs", async () => {
            const list = fakeList([
                "/sbin/launchd",
                WEBSTORM,
                "/bin/zsh",
                PYCHARM,
                // a helper under the same bundle, but its basename isn't an IDE launcher
                "/Applications/WebStorm.app/Contents/MacOS/fsnotifier"
            ])
            expect(await resolveExecPaths(list)).toEqual([WEBSTORM, PYCHARM])
        })

        it("dedupes repeated launcher paths (one process path per running product)", async () => {
            expect(await resolveExecPaths(fakeList([WEBSTORM, WEBSTORM, PYCHARM]))).toEqual([WEBSTORM, PYCHARM])
        })

        it("returns [] when no JetBrains IDE is running", async () => {
            expect(await resolveExecPaths(fakeList(["/bin/zsh", "/sbin/launchd"]))).toEqual([])
        })
    })

    context("resolveLogDir", () => {
        let home = ""
        const savedHome = process.env.HOME

        beforeEach(async () => {
            home = await mkdtemp(join(tmpdir(), "preemdeck-logdir-"))
            process.env.HOME = home
        })

        afterEach(async () => {
            if (savedHome === undefined) delete process.env.HOME
            else process.env.HOME = savedHome
            await rm(home, { recursive: true, force: true })
        })

        it("picks the active product's newest-version dir", async () => {
            const base = join(home, "Library/Logs/JetBrains")
            const newest = join(base, "WebStorm2025.3")
            const older = join(base, "WebStorm2025.1")
            const other = join(base, "PyCharm2024.3")
            for (const d of [newest, older, other]) await mkdir(d, { recursive: true })
            // mtimes: WebStorm2025.3 newest of its product; PyCharm is newer still but wrong product.
            await utimes(older, 1000, 1000)
            await utimes(newest, 2000, 2000)
            await utimes(other, 3000, 3000)

            expect(await resolveLogDir(() => "/x/WebStorm.app/Contents/MacOS/webstorm")).toBe(newest)
        })

        it("throws IdeaError when no dir matches the running product", async () => {
            // Running product is GoLand, but the only log dir on disk is PyCharm's.
            await mkdir(join(home, "Library/Logs/JetBrains/PyCharm2024.3"), { recursive: true })
            await expect(resolveLogDir(() => "/x/GoLand.app/Contents/MacOS/goland")).rejects.toThrow(IdeaError)
        })

        it("maps the 'idea' binary to the 'intellijidea' log-dir prefix", async () => {
            const base = join(home, "Library/Logs/JetBrains")
            const ij = join(base, "IntelliJIdea2025.2")
            await mkdir(ij, { recursive: true })
            expect(await resolveLogDir(() => "/x/IntelliJ IDEA.app/Contents/MacOS/idea")).toBe(ij)
        })
    })

    context("bundleToBasename", () => {
        it("lowercases the product suffix (WebStorm -> webstorm)", () => {
            expect(bundleToBasename("com.jetbrains.WebStorm")).toBe("webstorm")
        })

        it("renames intellij -> idea (the one product whose bundle != launcher)", () => {
            expect(bundleToBasename("com.jetbrains.intellij")).toBe("idea")
        })

        it("maps any other/unknown product to its lowercased suffix", () => {
            expect(bundleToBasename("com.jetbrains.PyCharm")).toBe("pycharm")
            expect(bundleToBasename("com.example.Foo")).toBe("foo")
        })

        it("is null for an empty, dot-less, or suffix-less id (the caller falls back)", () => {
            expect(bundleToBasename("")).toBeNull()
            expect(bundleToBasename("nodots")).toBeNull()
            expect(bundleToBasename("com.jetbrains.")).toBeNull()
        })
    })

    context("filterExecsForLaunchingProduct", () => {
        const PYCHARM = "/Applications/PyCharm.app/Contents/MacOS/pycharm"
        const IDEA = "/Applications/IntelliJ IDEA.app/Contents/MacOS/idea"

        it("keeps only the launching product's launcher", () => {
            expect(filterExecsForLaunchingProduct([WEBSTORM, PYCHARM], "com.jetbrains.WebStorm")).toEqual([WEBSTORM])
        })

        it("resolves the intellij bundle to the idea launcher", () => {
            expect(filterExecsForLaunchingProduct([IDEA, WEBSTORM], "com.jetbrains.intellij")).toEqual([IDEA])
        })

        it("falls back to the full set when the bundle maps to no basename", () => {
            expect(filterExecsForLaunchingProduct([WEBSTORM, PYCHARM], "")).toEqual([WEBSTORM, PYCHARM])
            expect(filterExecsForLaunchingProduct([WEBSTORM, PYCHARM], "nodots")).toEqual([WEBSTORM, PYCHARM])
        })

        it("falls back to the full set when no running launcher matches the product", () => {
            expect(filterExecsForLaunchingProduct([WEBSTORM, PYCHARM], "com.jetbrains.GoLand")).toEqual([
                WEBSTORM,
                PYCHARM
            ])
        })

        it("returns a fresh array (a copy) on the fallback path, not the input reference", () => {
            const input = [WEBSTORM, PYCHARM]
            const out = filterExecsForLaunchingProduct(input, "com.jetbrains.GoLand")
            expect(out).not.toBe(input)
            expect(out).toEqual(input)
        })

        it("drives the bundle id from __CFBundleIdentifier when the arg is omitted", () => {
            const saved = process.env.__CFBundleIdentifier
            try {
                process.env.__CFBundleIdentifier = "com.jetbrains.WebStorm"
                expect(filterExecsForLaunchingProduct([WEBSTORM, PYCHARM])).toEqual([WEBSTORM])
            } finally {
                if (saved === undefined) delete process.env.__CFBundleIdentifier
                else process.env.__CFBundleIdentifier = saved
            }
        })
    })
})
