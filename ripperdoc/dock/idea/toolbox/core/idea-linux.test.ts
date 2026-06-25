/**
 * idea-linux.test.ts — hermetic, no real `/proc` or IDE. Driven by an injected
 * ProcProbe fed a canned ancestry (MOCK PATTERN A — dependency injection),
 * mirroring idea-mac.test.ts so the Linux walk is exercised on any host.
 *
 * Only resolveExecPath is implemented on Linux today; inIdea/resolveLogDir
 * remain NotImplementedError stubs (asserted in index.test.ts).
 */

import { describe, expect, test } from "bun:test"
import { IdeaError } from "./errors.ts"
import { type ProcProbe, resolveExecPath } from "./idea-linux.ts"

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
            return null // unknown pid -> dead/unreadable -> break (parity with macOS)
        }
        return { ppid: entry[0], exe: entry[1] }
    }
}

describe("resolveExecPath (linux)", () => {
    test("walks the /proc ancestry to the IDE launcher", async () => {
        expect(await resolveExecPath(fakeProbe(ANCESTRY), 7539)).toBe(WEBSTORM)
    })

    test("skips the non-IDE leaf (the Bun runtime)", async () => {
        expect(await resolveExecPath(fakeProbe(ANCESTRY), 7539)).not.toContain(".runtime/bin/bun")
    })

    test("throws IdeaError when no JetBrains binary is in the chain", async () => {
        await expect(resolveExecPath(fakeProbe(NO_IDE), 4242)).rejects.toThrow(IdeaError)
    })

    test("stops the climb at a dead/exited pid (probe returns null)", async () => {
        // A probe that always reports "no such process" -> no IDE found -> IdeaError.
        await expect(resolveExecPath(async () => null, 999)).rejects.toThrow(IdeaError)
    })
})
