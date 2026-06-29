/**
 * idea-linux.ts — JetBrains IDE detection for the idea toolbox (Linux).
 *
 * resolveExecPath() is implemented: like macOS it reads the *running* IDE (not
 * project files) by walking the parent-process chain to the IDE launcher. The
 * ancestry probe reads `/proc` — `/proc/<pid>/exe` (a symlink to the full,
 * untruncated executable path; the `comm` field in `/proc/<pid>/stat` is capped
 * at 15 chars, so it is NOT used) and the `PPid:` line of `/proc/<pid>/status`.
 *
 * inIdea() and resolveLogDir() are not implemented yet (the JetBrains log tree
 * lives under a different, XDG-based path on Linux); they still throw
 * NotImplementedError.
 */

import { readdir, readFile, readlink } from "node:fs/promises"
import { IdeaError, NotImplementedError } from "./errors"
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

/** True when this terminal was launched by a JetBrains IDE — unimplemented on Linux. */
export const inIdea = (): boolean => {
    throw new NotImplementedError("inIdea is not implemented for Linux yet")
}

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
 * Log dir of the IDE this process is running inside — unimplemented on Linux.
 * Typed `Promise<string>` to match the async macOS surface, but throws
 * SYNCHRONOUSLY (before any promise is created).
 */
export const resolveLogDir = (): Promise<string> => {
    throw new NotImplementedError("resolveLogDir is not implemented for Linux yet")
}
