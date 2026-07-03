/**
 * idea-mac.ts — JetBrains IDE detection for the idea toolbox (macOS).
 *
 * Resolution reads the *running* IDE, not project
 * files: the IDE that opened the terminal is an ancestor process, so
 * resolveExecPath() walks up to its binary.
 *
 * `ps -o ppid=,comm=` is the ancestry probe. VERIFIED under the pinned Bun:
 * macOS `comm=` returns the FULL untruncated path (e.g. a 71-char
 * `/System/.../Contents/MacOS/loginwindow` came back whole via `ps`), so the
 * basename match against IDE_BINARIES works directly — no switch to `command=`
 * + split is needed. The classic ~15-char `comm` truncation is a Linux/procps
 * trait, not macOS BSD `ps`.
 */

import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { IdeaError } from "./errors"

/** Basenames of JetBrains IDE launchers at `<App>.app/Contents/MacOS/<name>`. */
export const IDE_BINARIES: ReadonlySet<string> = new Set([
    "webstorm",
    "pycharm",
    "idea",
    "goland",
    "phpstorm",
    "rubymine",
    "clion",
    "rider",
    "datagrip",
    "rustrover"
])

/** One ancestry step: a process's parent pid and its executable path. */
type PsEntry = {
    ppid: number
    exe: string
}

/**
 * One `ps -o ppid=,comm= -p <pid>` probe, parsed. Returns null when `ps`
 * produced fewer than two whitespace-split fields (a dead/exited pid). Split on
 * the FIRST whitespace run only, keeping the rest, so an exe path with spaces
 * stays intact.
 *
 * Injectable so tests can feed canned ancestry without spawning `ps` (the spec
 * injects a fake probe).
 */
export type PsProbe = (pid: number) => Promise<PsEntry | null>

const defaultPsProbe: PsProbe = async (pid) => {
    const proc = Bun.spawn(["ps", "-o", "ppid=,comm=", "-p", String(pid)], {
        stdout: "pipe"
    })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    // Strip leading whitespace, then split on the first whitespace run, keeping the rest.
    const trimmed = out.replace(/^\s+/, "")
    const match = trimmed.match(/^(\S+)\s+([\s\S]*)$/)
    if (match === null) {
        return null
    }
    const ppid = Number(match[1])
    const exe = (match[2] ?? "").trim()
    if (!Number.isFinite(ppid)) {
        return null
    }
    return { ppid, exe }
}

/** True when this terminal was launched by a JetBrains IDE. */
export const inIdea = (): boolean => {
    const bundle = process.env.__CFBundleIdentifier ?? ""
    return bundle.startsWith("com.jetbrains.") || process.env.TERMINAL_EMULATOR === "JetBrains-JediTerm"
}

/**
 * Absolute path to the JetBrains IDE binary this hook is running inside.
 *
 * The IDE that opened the terminal is an ancestor process; walk the parent
 * chain to it. Throws IdeaError if no JetBrains IDE is in the ancestry.
 *
 * This is the IDE that *launched* the process, not whichever IDE is focused:
 * switching focus to another IDE won't retarget it, and quitting the launching
 * IDE makes this throw (its orphaned child reparents away) rather than fall
 * through to a different IDE.
 *
 * `probe`/`startPid` are injectable seams for hermetic tests; production calls
 * use real `ps` and `process.pid`.
 */
export const resolveExecPath = async (
    probe: PsProbe = defaultPsProbe,
    startPid: number = process.pid
): Promise<string> => {
    let pid = startPid
    for (let i = 0; i < 16; i++) {
        // bounded climb
        const entry = await probe(pid)
        if (entry === null) {
            break
        }
        const { ppid, exe } = entry
        // basename: everything after the last "/".
        const base = exe.slice(exe.lastIndexOf("/") + 1)
        if (IDE_BINARIES.has(base)) {
            return exe
        }
        pid = ppid
        if (pid <= 1) {
            break
        }
    }
    throw new IdeaError("no JetBrains IDE in the process ancestry")
}

/**
 * Dedupe `exePaths` down to the distinct running JetBrains IDE launcher binaries
 * — those whose basename is in {@link IDE_BINARIES} — preserving first-seen order.
 *
 * The shared filter behind both platforms' `resolveExecPaths`: macOS feeds it
 * `ps -A` comm paths, Linux feeds it `/proc/<pid>/exe` targets. A product runs as
 * one process (multi-window is in-process), so dedupe collapses any repeats to one
 * launcher path per running product.
 */
export const filterIdeExecs = (exePaths: Iterable<string>): string[] => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const exe of exePaths) {
        const base = exe.slice(exe.lastIndexOf("/") + 1)
        if (IDE_BINARIES.has(base) && !seen.has(exe)) {
            seen.add(exe)
            out.push(exe)
        }
    }
    return out
}

/**
 * Map a JetBrains `__CFBundleIdentifier` to the launcher basename it runs as, or
 * `null` when the id carries no product suffix.
 *
 * The suffix (after the last `.`) lowercased IS the basename for most products
 * (`com.jetbrains.WebStorm` -> `webstorm`), with one rename: IntelliJ IDEA ships
 * as `com.jetbrains.intellij` but launches `idea`. A dot-less / empty id yields
 * `null` (no product to match) so the caller can fall back.
 */
export const bundleToBasename = (bundleId: string): string | null => {
    const dot = bundleId.lastIndexOf(".")
    if (dot < 0) {
        return null
    }
    const suffix = bundleId.slice(dot + 1)
    if (suffix.length === 0) {
        return null
    }
    const lower = suffix.toLowerCase()
    return lower === "intellij" ? "idea" : lower
}

/**
 * Narrow `execPaths` (running JetBrains launchers) to just the product that
 * launched THIS process — identified by `bundleId` (`__CFBundleIdentifier`, e.g.
 * `com.jetbrains.WebStorm`) mapped to its launcher basename.
 *
 * Used to aim `rename-tab`'s broadcast dispatch at the one IDE that owns our tab
 * instead of every running IDE. FALLS BACK to the full set (a fresh array copy)
 * when the id maps to no basename, or when no launcher matches it — so the
 * dispatch still reaches the IDE rather than no-op'ing on an unexpected id.
 * `bundleId` defaults to the live env (empty when unset -> full set).
 */
export const filterExecsForLaunchingProduct = (
    execPaths: Iterable<string>,
    bundleId: string = process.env.__CFBundleIdentifier ?? ""
): string[] => {
    const all = [...execPaths]
    const base = bundleToBasename(bundleId)
    if (base === null) {
        return all
    }
    const matched = all.filter((exe) => exe.slice(exe.lastIndexOf("/") + 1) === base)
    return matched.length > 0 ? matched : all
}

/**
 * Lists the executable path of every running process. Injectable so tests can
 * feed a canned process table without spawning `ps` (mirrors {@link PsProbe}).
 */
export type PsList = () => Promise<string[]>

const defaultPsList: PsList = async () => {
    try {
        const proc = Bun.spawn(["ps", "-A", "-o", "comm="], { stdout: "pipe" })
        const out = await new Response(proc.stdout).text()
        await proc.exited
        // macOS `comm=` is the FULL untruncated path (see file header), one per line.
        return out
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
    } catch {
        return [] // a `ps` spawn failure degrades to "no IDEs found", not a throw
    }
}

/**
 * Absolute paths to EVERY running JetBrains IDE launcher (not just the ancestry
 * one) — the broadcast target set for `notify --all`. Scans the whole process
 * table and keeps the distinct launcher binaries.
 *
 * Unlike {@link resolveExecPath} (the single ancestry binary), this reaches IDEs
 * the terminal was NOT launched from — a running PyCharm alongside the WebStorm
 * that opened this terminal. Returns `[]` when none are running (or the probe
 * fails); `list` is an injectable seam for hermetic tests.
 */
export const resolveExecPaths = async (list: PsList = defaultPsList): Promise<string[]> => {
    return filterIdeExecs(await list())
}

/**
 * Log dir of the IDE this process is running inside (active product, newest
 * version).
 *
 * Keyed off resolveExecPath(), so it inherits the same anchoring: the IDE that
 * launched this process, not whichever is focused.
 *
 * `resolveExec` is injectable for tests; production resolves the real ancestry.
 * The seam accepts a sync OR async resolver (the default is the now-async
 * `resolveExecPath`) and is awaited.
 */
export const resolveLogDir = async (
    resolveExec: () => string | Promise<string> = () => resolveExecPath()
): Promise<string> => {
    // The basename without its final suffix, lowercased.
    const execPath = await resolveExec()
    const baseName = execPath.slice(execPath.lastIndexOf("/") + 1)
    const dot = baseName.lastIndexOf(".")
    const stem = (dot > 0 ? baseName.slice(0, dot) : baseName).toLowerCase()
    const product = stem === "idea" ? "intellijidea" : stem

    // Honor $HOME (falling back to the OS home dir) so the tmp-HOME tests work.
    const home = process.env.HOME ?? homedir()
    const base = join(home, "Library/Logs/JetBrains")

    let names: string[]
    try {
        names = await readdir(base)
    } catch {
        names = []
    }

    const matches: Array<{ path: string; mtime: number }> = []
    for (const name of names) {
        if (!name.toLowerCase().startsWith(product)) {
            continue
        }
        const path = join(base, name)
        let st: Awaited<ReturnType<typeof stat>>
        try {
            st = await stat(path)
        } catch {
            continue
        }
        if (!st.isDirectory()) {
            continue
        }
        matches.push({ path, mtime: st.mtimeMs })
    }

    // Newest mtime first.
    matches.sort((a, b) => b.mtime - a.mtime)
    const newest = matches[0]
    if (newest === undefined) {
        throw new IdeaError(`no log dir for '${product}'`)
    }
    return newest.path
}
