/**
 * idea-linux.ts — JetBrains IDE detection for the idea toolbox (Linux).
 *
 * resolveExecPath() is implemented: like macOS it reads the *running* IDE (not
 * project files) by walking the parent-process chain to the IDE launcher. The
 * ancestry probe reads `/proc` — `/proc/<pid>/exe` (a symlink to the full,
 * untruncated executable path; the `comm` field in `/proc/<pid>/stat` is capped
 * at 15 chars, so it is NOT used) and the `PPid:` line of `/proc/<pid>/status`.
 *
 * When PID namespaces hide the IDE ancestry, resolveExecPath() falls back to
 * GNOME's inherited GIO_LAUNCHED_DESKTOP_FILE and its desktop Exec entry. Logs
 * resolve under the XDG cache root for the owning product.
 */

import { readdir, readFile, readlink } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { IdeaError } from "./errors"
// IDE launcher basenames + the shared dedupe filter are platform-neutral; share
// the single source of truth with macOS (index.ts loads both per-OS modules, so
// this adds no extra cost).
import { filterIdeExecs, IDE_BINARIES } from "./idea-mac"

/** One ancestry step: a process's parent pid and its executable path. */
type ProcEntry = {
    ppid: number
    exe: string
}

/**
 * One `/proc/<pid>` probe, parsed. Returns null when the pid is gone or
 * unreadable (the analog of macOS's "ps yielded <2 fields" break): readlink on a
 * dead pid's `exe` throws, and a missing `PPid:` line is treated the same way.
 *
 * Injectable so tests can feed canned ancestry without a real `/proc` (mirrors
 * the macOS PsProbe seam).
 */
export type ProcProbe = (pid: number) => Promise<ProcEntry | null>

const defaultProcProbe: ProcProbe = async (pid) => {
    let exe: string
    try {
        exe = await readlink(`/proc/${pid}/exe`)
    } catch {
        return null
    }
    let status: string
    try {
        status = await readFile(`/proc/${pid}/status`, "utf8")
    } catch {
        return null
    }
    const match = status.match(/^PPid:\s*(\d+)/m)
    if (match === null) {
        return null
    }
    const ppid = Number(match[1])
    if (!Number.isFinite(ppid)) {
        return null
    }
    return { ppid, exe }
}

/** True when this terminal was launched by JetBrains' JediTerm terminal. */
export const inIdea = (env: NodeJS.ProcessEnv = process.env): boolean => env.TERMINAL_EMULATOR === "JetBrains-JediTerm"

/** Parse the launcher token from a freedesktop `Exec=` entry. */
export const parseDesktopExec = (text: string): string | null => {
    const value = text.match(/^Exec\s*=\s*(.+)$/m)?.[1]?.trim()
    if (!value) return null
    const token = value
        .match(/^"([^"]+)"|^(\S+)/)
        ?.slice(1)
        .find((part): part is string => Boolean(part))
    return token?.startsWith("/") ? token : null
}

const PRODUCT_PREFIX_BY_BINARY: Readonly<Record<string, string>> = {
    webstorm: "WebStorm",
    pycharm: "PyCharm",
    idea: "IntelliJIdea",
    goland: "GoLand",
    phpstorm: "PhpStorm",
    rubymine: "RubyMine",
    clion: "CLion",
    rider: "Rider",
    datagrip: "DataGrip",
    rustrover: "RustRover"
}

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1).toLowerCase()

const productNameFromExec = (exec: string): string => {
    const product = PRODUCT_PREFIX_BY_BINARY[basename(exec)]
    if (!product) throw new IdeaError(`unknown JetBrains launcher: ${exec}`)
    return product
}

export type DesktopReader = (path: string, encoding: "utf8") => Promise<string>

const defaultDesktopReader: DesktopReader = async (path, encoding) => await readFile(path, encoding)

/**
 * Absolute path to the JetBrains IDE binary this process is running inside.
 *
 * The IDE that opened the terminal is an ancestor process; walk the parent chain
 * (bounded climb) to its launcher. Throws IdeaError if no JetBrains IDE is in
 * the ancestry. Mirrors the macOS walk exactly — only the probe differs (`/proc`
 * vs `ps`).
 *
 * `probe`/`startPid` are injectable seams for hermetic tests; production reads
 * the real `/proc` and `process.pid`.
 */
export const resolveExecPath = async (
    probe: ProcProbe = defaultProcProbe,
    startPid: number = process.pid,
    env: NodeJS.ProcessEnv = process.env,
    readDesktop: DesktopReader = defaultDesktopReader
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
        const base = basename(exe)
        if (IDE_BINARIES.has(base)) {
            return exe
        }
        pid = ppid
        if (pid <= 1) {
            break
        }
    }

    const desktopFile = env.GIO_LAUNCHED_DESKTOP_FILE
    const desktopText = desktopFile ? await readDesktop(desktopFile, "utf8").catch(() => "") : ""
    const desktopExec = parseDesktopExec(desktopText)
    if (desktopExec !== null && IDE_BINARIES.has(basename(desktopExec))) {
        return desktopExec
    }
    throw new IdeaError("no owning JetBrains IDE launcher found")
}

/**
 * Lists the executable path (`/proc/<pid>/exe` target) of every running process.
 * Injectable so tests can feed a canned process table without a real `/proc`
 * (mirrors the macOS {@link PsList} seam).
 */
export type ProcList = () => Promise<string[]>

const defaultProcList: ProcList = async () => {
    let names: string[]
    try {
        names = await readdir("/proc")
    } catch {
        return [] // no readable /proc -> "no IDEs found", not a throw
    }
    const out: string[] = []
    for (const name of names) {
        if (!/^\d+$/.test(name)) {
            continue // skip non-pid entries (cpuinfo, self, …)
        }
        try {
            out.push(await readlink(`/proc/${name}/exe`))
        } catch {
            // pid exited mid-scan, or its exe is unreadable (foreign owner) — skip it
        }
    }
    return out
}

/**
 * Absolute paths to EVERY running JetBrains IDE launcher (not just the ancestry
 * one) — the broadcast target set for `notify --all`. Scans `/proc` and keeps the
 * distinct launcher binaries. Mirrors the macOS surface; only the probe differs
 * (`/proc` vs `ps`). Returns `[]` when none are running; `list` is an injectable
 * seam for hermetic tests.
 */
export const resolveExecPaths = async (list: ProcList = defaultProcList): Promise<string[]> => {
    return filterIdeExecs(await list())
}

/**
 * Narrow running launchers to the product named by GNOME's desktop-file path.
 * Falls back to the full set when owner metadata is missing or no launcher
 * matches, preserving the shared best-effort dispatch contract.
 */
export const filterExecsForLaunchingProduct = (
    execPaths: Iterable<string>,
    owner: string = process.env.GIO_LAUNCHED_DESKTOP_FILE ?? ""
): string[] => {
    const all = [...execPaths]
    const ownerName = basename(owner)
    const product = [...IDE_BINARIES].find((binary) => ownerName.includes(binary))
    if (product === undefined) return all
    const matched = all.filter((exec) => basename(exec) === product)
    return matched.length > 0 ? matched : all
}

/**
 * Log dir of the owning IDE's newest product version under the XDG cache root.
 */
export const resolveLogDir = async (
    resolveExec: () => string | Promise<string> = () => resolveExecPath(),
    env: NodeJS.ProcessEnv = process.env
): Promise<string> => {
    const product = productNameFromExec(await resolveExec())
    const cacheRoot = env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache")
    const root = join(cacheRoot, "JetBrains")
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    const candidates = entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(product))
        .map((entry) => entry.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    const newest = candidates[0]
    if (newest === undefined) throw new IdeaError(`no ${product} log directory under ${root}`)
    return join(root, newest, "log")
}
