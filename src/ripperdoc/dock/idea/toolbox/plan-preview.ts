#!/usr/bin/env bun
/**
 * plan-preview.ts — open an agent's freshly-presented plan in the IDE's rendered
 * markdown preview. The plan-presentation hook entrypoint, fired by two hosts the
 * moment the agent exits plan mode:
 *
 *     Claude  PreToolUse  matcher ExitPlanMode    tool_input.plan       (markdown string)
 *     Gemini  BeforeTool  matcher exit_plan_mode  tool_input.plan_path  (markdown file)
 *
 * Both fire BEFORE the host's approval gate. run() branches on which field the
 * payload carries: Claude's inline plan -> openInline (.md temp); Gemini's path
 * -> open directly. Both opens are fire-and-forget + preview.
 *
 * When preemdeck.json sets `interactive: true`, run() takes a different branch
 * (openInteractive): materialize the plan to a fresh `.mdx`, spawn a dedicated
 * holo dev server on a hook-owned port, and open THAT URL in the IDE's JCEF tab
 * — a fresh server per plan, no reuse. Absent/false keeps the static preview.
 *
 * Best-effort and SILENT by contract: a missing IDE, absent/foreign stdin, or any
 * open/spawn failure yields a no-op (run() catches internally and returns
 * normally) so the host proceeds to its approval gate unchanged.
 */

import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { defineCommand, effect, execute } from "cmdore"
import { isInteractive, isNotifyEnabled } from "../../../../common/preemdeck"
import { inIdea, previewUrl } from "./core"
import { openFile } from "./open-file"
import { openInline } from "./open-inline"

type HookData = Record<string, unknown>

/**
 * Absolute path to holo's `serve.ts`, resolved relative to THIS file so it works
 * from the plugin cache regardless of cwd: toolbox → idea → dock → ripperdoc,
 * then down into `chrome/holo/toolbox`.
 */
const HOLO_SERVE = path.resolve(import.meta.dir, "..", "..", "..", "chrome", "holo", "toolbox", "serve.ts")

/** Monotonic counter so two plans materialized in the same millisecond get distinct temp names. */
let planCounter = 0

/**
 * Parse the hook's stdin payload as JSON; {} on anything unexpected. Guards
 * isTTY so a host that leaves stdin attached to the terminal never blocks.
 */
export const readHookInput = async (): Promise<HookData> => {
    let raw: string
    try {
        if (process.stdin.isTTY) {
            return {}
        }
        raw = await Bun.stdin.text()
    } catch {
        return {}
    }
    try {
        const data = raw.trim() ? JSON.parse(raw) : {}
        return data !== null && typeof data === "object" && !Array.isArray(data) ? (data as HookData) : {}
    } catch {
        return {}
    }
}

/**
 * Dispatch the plan to the IDE's rendered preview by which field is present.
 * `plan_path` (Gemini's file) is checked first and opened directly; otherwise
 * `plan` (Claude's inline string) is spilled to a .md temp and opened. The two
 * are host-exclusive, so the order is just defensive.
 */
const openPlan = async (toolInput: HookData): Promise<void> => {
    const planPath = toolInput.plan_path
    if (typeof planPath === "string" && planPath.trim()) {
        await openFile(planPath, { preview: true })
        return
    }
    const plan = toolInput.plan
    if (typeof plan === "string" && plan.trim()) {
        await openInline(plan, { suffix: ".md", preview: true })
    }
}

/**
 * Resolve the plan markdown from the payload: the inline `plan` string if
 * present, else the contents of `plan_path`. Returns null when neither yields
 * non-empty content — the interactive path then no-ops. Also returns a `source`
 * basename used to title the IDE tab (the plan file's name, else "plan").
 */
export const resolvePlanMarkdown = async (
    toolInput: HookData
): Promise<{ markdown: string; source: string } | null> => {
    const plan = toolInput.plan
    if (typeof plan === "string" && plan.trim()) {
        return { markdown: plan, source: "plan" }
    }
    const planPath = toolInput.plan_path
    if (typeof planPath === "string" && planPath.trim()) {
        const text = await fs.promises.readFile(planPath, "utf8")
        if (text.trim()) {
            return { markdown: text, source: path.basename(planPath) }
        }
    }
    return null
}

/**
 * Bind a `node:net` server on port 0 to let the OS pick a free port, read it
 * back, then close the socket and return the number. The hook OWNS the port this
 * way, so the URL is known WITHOUT parsing holo's ready banner. A small TOCTOU
 * race (the port could be taken between close and holo's bind) is acceptable
 * here — holo would auto-bump and the JCEF tab tolerates a reload.
 */
const findFreePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const server = net.createServer()
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
            const address = server.address()
            const port = address !== null && typeof address === "object" ? address.port : 0
            server.close(() => resolve(port))
        })
    })

/**
 * Poll a TCP connect against `port` until it accepts or `timeoutMs` elapses,
 * resolving when either happens (never rejects). Best-effort readiness so the
 * IDE tab points at a booting server that is more likely to answer; capped well
 * under the hook's 5s budget. A slow Vite cold-boot may still need a manual
 * reload — acceptable for fresh-per-plan servers.
 */
const waitForPort = (port: number, timeoutMs: number): Promise<void> =>
    new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs
        const attempt = (): void => {
            const socket = net.connect(port, "127.0.0.1")
            socket.once("connect", () => {
                socket.destroy()
                resolve()
            })
            socket.once("error", () => {
                socket.destroy()
                if (Date.now() >= deadline) {
                    resolve()
                } else {
                    setTimeout(attempt, 50)
                }
            })
        }
        attempt()
    })

/** How long the readiness poll waits before opening the tab anyway (well under the 5s hook budget). */
const READY_TIMEOUT_MS = 2000

/**
 * Injectable seams for {@link openInteractive} so the spec drives the interactive
 * branch WITHOUT binding a real port, spawning a real server, or touching a real
 * IDE. Each defaults to the real implementation; the side-effecting ones gate the
 * real work behind `effect()` so `--dry-run` rehearses the branch harmlessly.
 */
export type InteractiveDeps = {
    /** Resolve the plan markdown + a tab-title source from the payload. */
    resolvePlan: (toolInput: HookData) => Promise<{ markdown: string; source: string } | null>
    /** Materialize `markdown` to a fresh `.mdx` and return its absolute path. */
    writeMdx: (markdown: string) => Promise<string>
    /** Reserve a free TCP port the hook owns (so the URL is known without the banner). */
    findFreePort: () => Promise<number>
    /** Spawn holo's `serve.ts` DETACHED on `port`, pointed at `mdxPath`. */
    spawn: (mdxPath: string, port: number) => Promise<void>
    /** Best-effort wait for `port` to accept before the tab opens. */
    waitForPort: (port: number, timeoutMs: number) => Promise<void>
    /** Open `url` in the IDE (titled `title`); mirrors {@link previewUrl}. */
    openUrl: (url: string, title: string) => Promise<void>
}

/**
 * Write `markdown` to a FRESH temp `.mdx` and return its absolute path.
 *
 * The name is uniquified by `Date.now()` + a process-local counter — a hook, not
 * a Workflow script, so a wall-clock id is fine. The temp is deliberately NOT
 * reaped: the detached server reads it lazily (Vite compiles on request), so it
 * must outlive this short-lived hook. Fresh-per-plan servers orphan their `.mdx`
 * by design — no lifecycle, no reuse.
 */
const writeMdx = async (markdown: string): Promise<string> => {
    const mdxPath = path.join(os.tmpdir(), `holo-plan-${Date.now()}-${planCounter++}.mdx`)
    // effect(): on --dry-run this write is skipped so the branch rehearses without touching disk.
    await effect(() => fs.promises.writeFile(mdxPath, markdown, "utf8"))
    return mdxPath
}

/**
 * Spawn holo's `serve.ts` DETACHED with the host runtime, pointed at `mdxPath` on
 * `port`. Mirrors wire/start.ts's idiom: redirect stdout/stderr to a temp log fd,
 * `stdin: "ignore"`, then `proc.unref()` so the child outlives this hook. Wrapped
 * in `effect()` so `--dry-run` never forks a server. Passes `--kill-on-disconnect`
 * so this fresh-per-plan server self-reaps once its IDE tab closes — no orphaned
 * Vite process left behind (the manual `serve` path omits the flag, stays up).
 */
const spawnHolo = async (mdxPath: string, port: number): Promise<void> => {
    await effect(() => {
        const log = path.join(os.tmpdir(), `holo-plan-${Date.now()}-${planCounter++}.log`)
        const fd = fs.openSync(log, "w")
        try {
            const proc = Bun.spawn(
                [process.execPath, HOLO_SERVE, mdxPath, "--port", String(port), "--kill-on-disconnect"],
                {
                    stdin: "ignore",
                    stdout: fd,
                    stderr: fd
                }
            )
            // The server must outlive this hook, which returns right after the open.
            proc.unref()
        } finally {
            fs.closeSync(fd)
        }
    })
}

const DEFAULT_INTERACTIVE_DEPS: InteractiveDeps = {
    resolvePlan: resolvePlanMarkdown,
    writeMdx,
    findFreePort,
    spawn: spawnHolo,
    waitForPort,
    // effect(): on --dry-run the IDE open is skipped; previewUrl itself never throws.
    openUrl: async (url, title) => {
        await effect(() => previewUrl(url, title, process.cwd()))
    }
}

/**
 * Interactive plan preview: materialize the plan to a fresh `.mdx`, spawn a
 * dedicated holo dev server on a hook-owned port, and open its URL in the IDE's
 * JCEF web-preview tab. Fresh server PER plan — no reuse, no lifecycle; the temp
 * `.mdx` is orphaned by design.
 *
 * Best-effort and never-throw by the hook's contract: `deps` inject every seam so
 * the spec exercises the branch without a real port/server/IDE. Steps: resolve
 * the markdown (no content → no-op), write the `.mdx`, reserve a free port, assert
 * holo's `serve.ts` exists, spawn it detached, optionally poll readiness (capped
 * at {@link READY_TIMEOUT_MS}), then open the URL REGARDLESS — the tab tolerates a
 * booting server.
 */
export const openInteractive = async (
    toolInput: HookData,
    deps: InteractiveDeps = DEFAULT_INTERACTIVE_DEPS
): Promise<void> => {
    const resolved = await deps.resolvePlan(toolInput)
    if (resolved === null) {
        return // no plan content: nothing to serve
    }
    const mdxPath = await deps.writeMdx(resolved.markdown)
    const port = await deps.findFreePort()
    // Defensive: without serve.ts on disk there is nothing to spawn — bail quietly.
    if (!fs.existsSync(HOLO_SERVE)) {
        return
    }
    await deps.spawn(mdxPath, port)
    await deps.waitForPort(port, READY_TIMEOUT_MS)
    await deps.openUrl(`http://127.0.0.1:${port}`, resolved.source)
}

const command = defineCommand({
    name: "plan-preview",
    description: "Open an agent's freshly-presented plan in the IDE's rendered markdown preview.",
    arguments: [{ name: "host", description: "invoking host name (ignored; the stdin field selects the path)" }],
    run: async () => {
        // Best-effort: a pre-tool hook must never error or block the host, so any
        // failure inside the dispatch is swallowed and run() returns normally.
        try {
            if (!(await isNotifyEnabled("plan"))) {
                return // user disabled plan previews via preemdeck.json notify.plan
            }
            if (!inIdea()) {
                return // not inside a JetBrains IDE: nothing to open, and no error
            }
            const data = await readHookInput()
            const toolInput = data.tool_input
            if (toolInput !== null && typeof toolInput === "object" && !Array.isArray(toolInput)) {
                // interactive: true serves the plan via holo and opens the running
                // URL; absent/false keeps today's static IDE markdown preview.
                if (await isInteractive()) {
                    await openInteractive(toolInput as HookData)
                } else {
                    await openPlan(toolInput as HookData)
                }
            }
        } catch {
            // swallow: never disrupt the host
        }
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
