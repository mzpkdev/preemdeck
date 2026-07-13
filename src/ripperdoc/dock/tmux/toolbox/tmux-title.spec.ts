/**
 * tmux-title.spec.ts — exercises tmux-title.ts at two layers.
 *
 * UNIT (hermetic, no real tmux): the pure argv/name builders are checked directly,
 * and applyTitle is driven with an injected env + run seam (DI). The real runTmux
 * seam is exercised against silent subprocesses (MOCK PATTERN D, lightly).
 *
 * E2E (subprocess): spawn tmux-title.ts under --dry-run so effect() skips the real
 * spawn — the process exits 0 and, critically, writes NOTHING to stdout (a
 * SessionStart/UserPromptSubmit hook's stdout is fed back to the model as context).
 * Mirrors open-file.spec's subprocess harness.
 */

import { describe, expect, it } from "bun:test"
import * as path from "node:path"
import { applyTitle, GLYPH, projectLabel, runTmux, tmuxArgs, windowName } from "./tmux-title"

const context = describe

// A fake run that records argv and answers with a fixed result.
const fakeRun = (result: boolean): { calls: string[][]; run: (cmd: string[]) => Promise<boolean> } => {
    const calls: string[][] = []
    return {
        calls,
        run: (cmd: string[]) => {
            calls.push(cmd)
            return Promise.resolve(result)
        }
    }
}

const env = (extra: Record<string, string>): NodeJS.ProcessEnv => extra as NodeJS.ProcessEnv

// Spawn the CLI as a real subprocess. --dry-run makes effect() skip the real tmux spawn.
const run = async (
    args: string[],
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "tmux-title.ts"), ...args], {
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

describe("tmux-title", () => {
    context("windowName — glyph + project", () => {
        it("prefixes the state glyph to the project", () => {
            expect(windowName("idle", "preemdeck")).toBe(`${GLYPH.idle} preemdeck`)
            expect(windowName("busy", "preemdeck")).toBe(`${GLYPH.busy} preemdeck`)
            expect(windowName("waiting", "preemdeck")).toBe(`${GLYPH.waiting} preemdeck`)
        })
        it("is the bare glyph when the project is unknown", () => {
            expect(windowName("idle", "")).toBe(GLYPH.idle as string)
        })
    })

    context("projectLabel — the host's project dir basename", () => {
        it("reads CLAUDE_PROJECT_DIR first", () => {
            expect(projectLabel(env({ CLAUDE_PROJECT_DIR: "/home/me/myproj", PWD: "/elsewhere" }))).toBe("myproj")
        })
        it("falls back to GEMINI_PROJECT_DIR, then PWD", () => {
            expect(projectLabel(env({ GEMINI_PROJECT_DIR: "/a/gem" }))).toBe("gem")
            expect(projectLabel(env({ PWD: "/a/pwd" }))).toBe("pwd")
        })
        it("is empty when no dir is known", () => {
            expect(projectLabel(env({}))).toBe("")
        })
    })

    context("tmuxArgs — the pure argv builder", () => {
        it("renames the window to the state name, targeting the pane", () => {
            expect(tmuxArgs("busy", "proj", "%3")).toEqual(["tmux", "rename-window", "-t", "%3", `${GLYPH.busy} proj`])
        })
        it("omits -t when no pane is known (active window)", () => {
            expect(tmuxArgs("idle", "proj", undefined)).toEqual(["tmux", "rename-window", `${GLYPH.idle} proj`])
        })
        it("restores automatic-rename on reset", () => {
            expect(tmuxArgs("reset", "proj", "%3")).toEqual([
                "tmux",
                "set-window-option",
                "-t",
                "%3",
                "automatic-rename",
                "on"
            ])
        })
        it("is null for an unknown state", () => {
            expect(tmuxArgs("bogus", "proj", "%3")).toBeNull()
        })
    })

    context("applyTitle — gated by $TMUX, dispatched through the run seam", () => {
        it("is a no-op outside tmux (no $TMUX)", async () => {
            const f = fakeRun(true)
            expect(await applyTitle("idle", env({ TMUX_PANE: "%1" }), f.run)).toBe(false)
            expect(f.calls.length).toBe(0)
        })
        it("renames the pane's window when inside tmux", async () => {
            const f = fakeRun(true)
            const result = await applyTitle(
                "idle",
                env({ TMUX: "/tmp/tmux-501/default,1,0", TMUX_PANE: "%2", CLAUDE_PROJECT_DIR: "/a/proj" }),
                f.run
            )
            expect(result).toBe(true)
            expect(f.calls).toEqual([["tmux", "rename-window", "-t", "%2", `${GLYPH.idle} proj`]])
        })
        it("is a no-op for an unknown state even inside tmux", async () => {
            const f = fakeRun(true)
            expect(await applyTitle("bogus", env({ TMUX: "/tmp/x", TMUX_PANE: "%1" }), f.run)).toBe(false)
            expect(f.calls.length).toBe(0)
        })
    })

    context("runTmux — the real (silent) subprocess seam", () => {
        it("is false for a missing binary", async () => {
            expect(await runTmux(["preemdeck-no-such-binary-zzz"])).toBe(false)
        })
        it("is true for a zero exit", async () => {
            expect(await runTmux(["sh", "-c", "exit 0"])).toBe(true)
        })
        it("is false for a non-zero exit", async () => {
            expect(await runTmux(["sh", "-c", "exit 3"])).toBe(false)
        })
    })

    context("CLI e2e — never pollutes stdout, always exits 0", () => {
        it("exits 0 with empty stdout inside tmux (--dry-run skips the real spawn)", async () => {
            const { code, stdout } = await run(["--dry-run", "busy"], {
                TMUX: "/tmp/tmux-501/default,1,0",
                TMUX_PANE: "%1"
            })
            expect(code).toBe(0)
            expect(stdout).toBe("")
        })
        it("exits 0 with empty stdout outside tmux", async () => {
            const { code, stdout } = await run(["idle"], { TMUX: "" })
            expect(code).toBe(0)
            expect(stdout).toBe("")
        })
    })
})
