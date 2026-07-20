import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { IdeaError } from "./errors"
import {
    filterExecsForLaunchingProduct,
    inIdea,
    type ProcList,
    type ProcProbe,
    parseDesktopExec,
    resolveExecPath,
    resolveExecPaths,
    resolveLogDir
} from "./idea-linux"

const context = describe

// A native JetBrains launcher path as seen via /proc/<pid>/exe on Linux.
const WEBSTORM = "/opt/webstorm/bin/webstorm"

// Ancestry observed under WebStorm on Linux: pid -> (ppid, exe).
// The leaf is the toolbox's own Bun runtime — a non-IDE binary that must be skipped.
const ANCESTRY: Record<number, [number, string]> = {
    7539: [7537, "/home/dev/.preemdeck/.runtime/bin/bun"],
    7537: [81159, "/usr/bin/zsh"],
    81159: [24643, "/usr/bin/claude"],
    24643: [57130, "/usr/bin/zsh"],
    57130: [1, WEBSTORM]
}

// A chain with no JetBrains binary: zsh -> init -> pid 1.
const NO_IDE: Record<number, [number, string]> = {
    4242: [4241, "/usr/bin/zsh"],
    4241: [1, "/sbin/init"]
}

/** Build a ProcProbe keyed off the pid (async seam, like the real /proc read). */
const fakeProbe = (ancestry: Record<number, [number, string]>): ProcProbe => {
    return async (pid) => {
        const entry = ancestry[pid]
        if (entry === undefined) {
            return null // unknown pid -> dead/unreadable -> break (same as macOS)
        }
        return { ppid: entry[0], exe: entry[1] }
    }
}

describe("idea (linux)", () => {
    context("inIdea", () => {
        it("recognizes JediTerm without a force flag", () => {
            expect(inIdea({ TERMINAL_EMULATOR: "JetBrains-JediTerm" })).toBe(true)
            expect(inIdea({ TERMINAL_EMULATOR: "xterm-256color" })).toBe(false)
            expect(inIdea({})).toBe(false)
        })
    })

    context("parseDesktopExec", () => {
        it("reads quoted and unquoted absolute launchers", () => {
            expect(parseDesktopExec('[Desktop Entry]\nExec="/opt/WebStorm/bin/webstorm" %f\n')).toBe(
                "/opt/WebStorm/bin/webstorm"
            )
            expect(parseDesktopExec("[Desktop Entry]\nExec=/opt/WebStorm/bin/webstorm %f\n")).toBe(
                "/opt/WebStorm/bin/webstorm"
            )
        })

        it("rejects missing, malformed, and relative Exec values", () => {
            expect(parseDesktopExec("[Desktop Entry]\nName=WebStorm\n")).toBeNull()
            expect(parseDesktopExec("Exec=webstorm %f\n")).toBeNull()
            expect(parseDesktopExec('Exec="unterminated\n')).toBeNull()
        })
    })

    context("resolveExecPath", () => {
        it("walks the /proc ancestry to the IDE launcher", async () => {
            expect(await resolveExecPath(fakeProbe(ANCESTRY), 7539)).toBe(WEBSTORM)
        })

        it("skips the non-IDE leaf (the Bun runtime)", async () => {
            expect(await resolveExecPath(fakeProbe(ANCESTRY), 7539)).not.toContain(".runtime/bin/bun")
        })

        it("throws IdeaError when no JetBrains binary is in the chain", async () => {
            await expect(resolveExecPath(fakeProbe(NO_IDE), 4242, {})).rejects.toThrow(IdeaError)
        })

        it("stops the climb at a dead/exited pid (probe returns null)", async () => {
            // A probe that always reports "no such process" -> no IDE found -> IdeaError.
            await expect(resolveExecPath(async () => null, 999, {})).rejects.toThrow(IdeaError)
        })

        it("falls back to the GNOME desktop launcher outside the host PID namespace", async () => {
            const exec = await resolveExecPath(
                async () => null,
                42,
                { GIO_LAUNCHED_DESKTOP_FILE: "/apps/jetbrains-webstorm.desktop" },
                async () => '[Desktop Entry]\nExec="/opt/WebStorm/bin/webstorm" %f\n'
            )
            expect(exec).toBe("/opt/WebStorm/bin/webstorm")
        })

        it("prefers ancestry and does not read the desktop file when both are available", async () => {
            let reads = 0
            const exec = await resolveExecPath(
                fakeProbe(ANCESTRY),
                7539,
                { GIO_LAUNCHED_DESKTOP_FILE: "/apps/jetbrains-webstorm.desktop" },
                async () => {
                    reads++
                    return "Exec=/wrong/bin/pycharm\n"
                }
            )
            expect(exec).toBe(WEBSTORM)
            expect(reads).toBe(0)
        })

        it("throws IdeaError when the desktop file is unreadable or has no JetBrains launcher", async () => {
            const env = { GIO_LAUNCHED_DESKTOP_FILE: "/apps/bad.desktop" }
            await expect(
                resolveExecPath(
                    async () => null,
                    42,
                    env,
                    async () => "Exec=/usr/bin/code\n"
                )
            ).rejects.toThrow(IdeaError)
            await expect(
                resolveExecPath(
                    async () => null,
                    42,
                    env,
                    async () => {
                        throw new Error("ENOENT")
                    }
                )
            ).rejects.toThrow(IdeaError)
        })
    })

    context("resolveExecPaths", () => {
        const PYCHARM = "/opt/pycharm/bin/pycharm"
        const fakeList =
            (paths: string[]): ProcList =>
            async () =>
                paths

        it("keeps every distinct running JetBrains launcher, skipping non-IDE procs", async () => {
            const list = fakeList(["/usr/bin/zsh", WEBSTORM, PYCHARM, "/opt/webstorm/bin/fsnotifier"])
            expect(await resolveExecPaths(list)).toEqual([WEBSTORM, PYCHARM])
        })

        it("dedupes repeated launcher paths (one /proc exe per running product)", async () => {
            expect(await resolveExecPaths(fakeList([WEBSTORM, WEBSTORM]))).toEqual([WEBSTORM])
        })

        it("returns [] when no JetBrains IDE is running", async () => {
            expect(await resolveExecPaths(fakeList(["/usr/bin/zsh", "/sbin/init"]))).toEqual([])
        })
    })

    context("filterExecsForLaunchingProduct", () => {
        const PYCHARM = "/opt/pycharm/bin/pycharm"

        it("keeps only the product named by the GNOME desktop file", () => {
            expect(
                filterExecsForLaunchingProduct(
                    [WEBSTORM, PYCHARM],
                    "/usr/share/applications/jetbrains-webstorm.desktop"
                )
            ).toEqual([WEBSTORM])
        })

        it("falls back to the full set when owner metadata is absent or unmatched", () => {
            expect(filterExecsForLaunchingProduct([WEBSTORM, PYCHARM], "")).toEqual([WEBSTORM, PYCHARM])
            expect(filterExecsForLaunchingProduct([WEBSTORM], "/apps/jetbrains-pycharm.desktop")).toEqual([WEBSTORM])
        })
    })

    context("resolveLogDir", () => {
        const temps: string[] = []
        afterEach(async () => {
            await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
        })

        it("uses XDG_CACHE_HOME and selects the newest directory for the owning product", async () => {
            const cache = await mkdtemp(join(tmpdir(), "preemdeck-linux-logs-"))
            temps.push(cache)
            const root = join(cache, "JetBrains")
            await Promise.all([
                mkdir(join(root, "WebStorm2025.3", "log"), { recursive: true }),
                mkdir(join(root, "WebStorm2026.1", "log"), { recursive: true }),
                mkdir(join(root, "PyCharm2027.1", "log"), { recursive: true })
            ])
            expect(await resolveLogDir(() => WEBSTORM, { XDG_CACHE_HOME: cache })).toBe(
                join(root, "WebStorm2026.1", "log")
            )
        })

        it("falls back to HOME/.cache and errors when the product directory is absent", async () => {
            const home = await mkdtemp(join(tmpdir(), "preemdeck-linux-home-"))
            temps.push(home)
            await expect(resolveLogDir(() => WEBSTORM, { HOME: home })).rejects.toThrow(IdeaError)
        })
    })
})
