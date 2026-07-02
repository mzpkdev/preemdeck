/**
 * testkit.ts — shared bun-test seams for the install/uninstall/update suites.
 *
 * fakeChild/realSpawn back the `spyOn(Bun, "spawn")` seam; seedRipperdoc/seedOverlay/
 * walkRel back the real-FS fixtures; captureExit/silenceLog wrap the process.exit +
 * console.log spies. The spawn spy lifecycle stays per-file (it's stateful) — these are
 * the stateless pieces every suite shares.
 */

import { spyOn } from "bun:test"
import { mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// A canned Bun.Subprocess: stdout/stderr as drainable streams + a resolved exit. reap()
// reads the streams to text and awaits `exited`, so this stands in for a real child
// WITHOUT spawning one. Built per-call (fresh, un-consumed streams).
export const fakeChild = (stdout = "", exitCode = 0, stderr = "") =>
    ({
        stdout: new Response(stdout).body,
        stderr: new Response(stderr).body,
        exited: Promise.resolve(exitCode),
        exitCode,
        kill() {}
    }) as unknown as Bun.Subprocess

// The genuine Bun.spawn, captured before any spying — the runCli timeout test delegates
// the spy to it to drive reap's REAL timer against a real `sleep` child. Cast back to the
// full overloaded signature (bind() collapses it) so `realSpawn(...args)` resolves.
export const realSpawn = Bun.spawn.bind(Bun) as typeof Bun.spawn

/**
 * Seed a fixture src/ripperdoc/ under repoRoot with BOTH allowlisted primitives and a
 * representative spread of excluded files (code, docs, data, nested toolbox/scripts).
 */
export function seedRipperdoc(repoRoot: string): void {
    const w = (rel: string, body: string) => {
        const p = join(repoRoot, "src", "ripperdoc", rel)
        mkdirSync(join(p, ".."), { recursive: true })
        writeFileSync(p, body)
    }
    // allowlisted primitives
    w(
        "dock/.claude-plugin/marketplace.json",
        JSON.stringify({ name: "dock", plugins: [{ name: "idea", source: "./idea", version: "0.0.0" }] })
    )
    w("dock/.agents/plugins/marketplace.json", JSON.stringify({ name: "dock", plugins: [] }))
    w("dock/idea/.claude-plugin/plugin.json", JSON.stringify({ name: "idea", version: "0.0.0" }))
    w("dock/idea/.codex-plugin/plugin.json", JSON.stringify({ name: "idea", version: "0.0.0" }))
    w("dock/idea/.codex-plugin/hooks/hooks.json", JSON.stringify({ hooks: {} }))
    w("dock/idea/gemini-extension.json", JSON.stringify({ name: "idea", version: "0.0.0" }))
    w("dock/idea/skills/using/SKILL.md", "# using")
    w("wetware/directive/commands/swarm.toml", "name = 'swarm'")
    // excluded: code, docs, data, nested dirs
    w("dock/idea/toolbox/open-file.ts", "export const x = 1;")
    w("dock/idea/toolbox/core/index.ts", "export const y = 2;")
    w("dock/idea/scripts/build.ts", "// build")
    w("wetware/directive/skills/ask/directive.md", "# directive")
    w("wetware/directive/skills/ask/agents/openai.yaml", "name: ask")
    w("wetware/directive/scripts/modes.json", JSON.stringify({ modes: [] }))
    w("dock/idea/README.md", "# readme")
    w("wetware/ghost/engram.dat", "binary")
    w("wetware/ghost/stock/ENGRAM.md", "# stock")
    w("wetware/imprint/IMPRINT.md", "# imprint")
    w("wetware/imprint/hosts/host_gemini.md", "# host")
}

/** Recursively list files under root, POSIX-joined relative paths. */
export function walkRel(root: string): string[] {
    const out: string[] = []
    for (const e of readdirSync(root, { withFileTypes: true })) {
        const f = join(root, e.name)
        if (e.isDirectory()) {
            out.push(...walkRel(f).map((r) => `${e.name}/${r}`))
        } else {
            out.push(e.name)
        }
    }
    return out
}

/** Seed a per-harness overlay (settings.json + agents/fixer.md) under repoRoot. */
export function seedOverlay(repoRoot: string, harness = "claude"): void {
    const src = join(repoRoot, "src", "overwrite", harness)
    mkdirSync(join(src, "agents"), { recursive: true })
    writeFileSync(join(src, "settings.json"), '{"_": "overlay"}')
    writeFileSync(join(src, "agents", "fixer.md"), "# fixer overlay")
}

/** Run `fn`, capturing the process.exit code + everything written to stderr. */
export function captureExit(fn: () => unknown): { code: number | null; stderr: string } {
    let code: number | null = null
    let stderr = ""
    const exitSpy = spyOn(process, "exit").mockImplementation(((c?: number) => {
        code = c ?? 0
        throw new Error(`__exit__:${code}`)
    }) as never)
    const errSpy = spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
        stderr += chunk
        return true
    }) as never)
    try {
        fn()
    } catch (e) {
        if (!(e instanceof Error) || !e.message.startsWith("__exit__:")) throw e
    } finally {
        exitSpy.mockRestore()
        errSpy.mockRestore()
    }
    return { code, stderr }
}

/** Silence console.log for a block; returns the spy so the caller can restore it. */
export const silenceLog = () => spyOn(console, "log").mockImplementation(() => {})
