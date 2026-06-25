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
import { IdeaError } from "./errors.ts"

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
 * produced fewer than two whitespace-split fields (the reference `len(out) < 2`
 * break — a dead/exited pid). Split on the FIRST run of whitespace only, so an
 * exe path with spaces stays intact (the reference `.split(maxsplit=1)`).
 *
 * Injectable so tests can feed canned ancestry without spawning `ps` (mirrors
 * the reference tests monkeypatching `idea_mac.subprocess.run`).
 */
export type PsProbe = (pid: number) => Promise<PsEntry | null>

const defaultPsProbe: PsProbe = async (pid) => {
    const proc = Bun.spawn(["ps", "-o", "ppid=,comm=", "-p", String(pid)], {
        stdout: "pipe"
    })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    // Reference: out.split(maxsplit=1) — leading whitespace stripped, split once.
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
        // basename: everything after the last "/" (the reference str.rpartition("/")[2]).
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
    // Path(exec).stem.lower(): the basename without its final suffix, lowercased.
    const execPath = await resolveExec()
    const baseName = execPath.slice(execPath.lastIndexOf("/") + 1)
    const dot = baseName.lastIndexOf(".")
    const stem = (dot > 0 ? baseName.slice(0, dot) : baseName).toLowerCase()
    const product = stem === "idea" ? "intellijidea" : stem

    // Path.home() honors $HOME; mirror that so the tmp-HOME tests work.
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

    // Newest mtime first (the reference sorted(..., key=mtime, reverse=True)).
    matches.sort((a, b) => b.mtime - a.mtime)
    const newest = matches[0]
    if (newest === undefined) {
        throw new IdeaError(`no log dir for '${product}'`)
    }
    return newest.path
}
