#!/usr/bin/env bun
/**
 * serve.ts — the FOREGROUND holo server (blocking).
 *
 * Serve a plan file (`.mdx`/`.md`) as a live, EDITABLE page over HTTP — a browser
 * view of an agent's plan a human can edit in place. Resolves + validates the
 * target file, builds an inline Vite dev config (no vite.config on disk) rooted at
 * the committed `app/` template, and mounts a tiny `/__holo/plan` endpoint that
 * READS the file (to seed the in-browser MDX editor) and WRITES edits back to it,
 * so the on-disk file stays the canonical artifact the agent reads. Boots Vite in
 * dev mode, prints the greppable `holo: ready` banner, and blocks until a signal.
 *
 * The deterministic prelude (resolve + validate the path, build the config,
 * would-print the banner) is pure and unit-testable, and the endpoint's decision
 * is factored out pure too ({@link handlePlanIo}); only the real side-effects —
 * `server.listen()` and the shutdown block — ride `effect()`, so `--dry-run`
 * rehearses the whole prelude WITHOUT binding a port.
 */

import * as fs from "node:fs"
import type { IncomingMessage } from "node:http"
import * as path from "node:path"
import react from "@vitejs/plugin-react"
import { defineCommand, effect, execute } from "cmdore"
import { createServer, type InlineConfig, type ViteDevServer } from "vite"
import { integer } from "./coerce"

/** The committed app template dir Vite roots at; holds `index.html` + `entry.jsx`. */
const APP_ROOT = path.join(import.meta.dir, "app")

/** The committed default stylesheet the page loads unless `--css` overrides it. */
export const DEFAULT_CSS = path.join(APP_ROOT, "style.css")

/** The repo root, allow-listed for file serving alongside the app root + the mdx dir. */
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..")

/** Stable id the entry imports for its stylesheet; aliased to {@link DEFAULT_CSS} or the `--css` override. */
export const STYLE_ALIAS = "@holo-style"

/** Extensions holo accepts as a plan source; the browser editor edits either as markdown/MDX. */
const MDX_EXTENSIONS = new Set([".mdx", ".md"])

/** Raised to fail the launch cleanly (exit 1) with a `holo: error:` message. */
export class ServeError extends Error {}

/** The launch knobs serve resolves; `open` is `undefined` when unset (pass-through to Vite). */
export type ServeOptions = {
    host: string
    port: number
    open?: boolean
    killOnDisconnect?: boolean
    /** Optional `--css` override path (a `.css` file); absent → {@link DEFAULT_CSS}. */
    css?: string
}

/**
 * Grace window (ms) after the last HMR client drops before the server self-reaps.
 *
 * A steady-state HMR edit keeps the socket open (Vite pushes over the persistent
 * ws), so only a full reload or a real tab close severs it — and a reload
 * immediately reconnects. This window absorbs that reconnect blip so a reload
 * does NOT kill the server; only a viewer that stays gone triggers the reap.
 * Only consulted under `--kill-on-disconnect`.
 */
export const DISCONNECT_GRACE_MS = 5000

/**
 * Backstop timeout (ms) armed at start: if NO client ever connects, reap anyway.
 *
 * The interactive plan hook spawns a server then opens a tab; if that tab never
 * materializes (open failed, host quit), nothing would ever connect and the
 * process would leak forever. This ceiling reaps such a never-viewed spawn.
 * Only consulted under `--kill-on-disconnect`.
 */
export const STARTUP_TIMEOUT_MS = 60000

/**
 * A pure, testable state machine that decides WHEN to reap a server based on HMR
 * client connect/disconnect events — extracted from any real socket so the spec
 * drives it with fake timers.
 *
 * Lifecycle: {@link DisconnectReaper.start} arms a startup backstop; the first
 * {@link DisconnectReaper.onConnect} cancels it and marks the server "seen". Once
 * seen, each {@link DisconnectReaper.onDisconnect} that drops the live count to 0
 * arms a grace timer; if a client reconnects (onConnect) before it fires, the
 * timer is cancelled (a reload blip is absorbed); if the timer elapses with the
 * count still 0, `onReap` fires exactly once. Before the first connect, the only
 * path to a reap is the startup backstop — a disconnect can never fire first.
 */
export type DisconnectReaper = {
    /** Arm the startup backstop: reap if no client connects within `startupMs`. */
    start: () => void
    /** Record a client connecting: cancel the startup backstop and any pending grace timer. */
    onConnect: () => void
    /** Record a client disconnecting: if the count hits 0 (and ≥1 was seen), arm the grace timer. */
    onDisconnect: () => void
}

/**
 * Build a {@link DisconnectReaper} over injectable timer primitives so the spec
 * can drive it deterministically (no real `setTimeout`, no real socket).
 *
 * `onReap` is invoked AT MOST ONCE — the first time either the startup backstop
 * or the grace window elapses with no live clients. `setTimer`/`clearTimer` are
 * generic over the handle type `T` so the real wiring passes Node's
 * `setTimeout`/`clearTimeout` and the spec passes fakes.
 *
 * @typeParam T - the timer handle type returned by `setTimer` and consumed by `clearTimer`.
 * @param opts - grace/startup windows, the reap callback, and the timer primitives.
 * @returns the reaper's `start`/`onConnect`/`onDisconnect` handlers.
 *
 * @example
 * const reaper = createDisconnectReaper({
 *     graceMs: 5000,
 *     startupMs: 60000,
 *     onReap: () => server.close(),
 *     setTimer: (fn, ms) => setTimeout(fn, ms),
 *     clearTimer: (t) => clearTimeout(t)
 * })
 * reaper.start()
 */
export const createDisconnectReaper = <T>(opts: {
    graceMs: number
    startupMs: number
    onReap: () => void
    setTimer: (fn: () => void, ms: number) => T
    clearTimer: (timer: T) => void
}): DisconnectReaper => {
    let count = 0
    let seen = false
    let reaped = false
    let startupTimer: T | undefined
    let graceTimer: T | undefined

    const clearStartup = (): void => {
        if (startupTimer !== undefined) {
            opts.clearTimer(startupTimer)
            startupTimer = undefined
        }
    }
    const clearGrace = (): void => {
        if (graceTimer !== undefined) {
            opts.clearTimer(graceTimer)
            graceTimer = undefined
        }
    }
    const reap = (): void => {
        if (reaped) {
            return
        }
        reaped = true
        clearStartup()
        clearGrace()
        opts.onReap()
    }

    return {
        start: (): void => {
            // Backstop: a spawn whose tab never opens must not leak forever.
            startupTimer = opts.setTimer(() => {
                if (!seen && count === 0) {
                    reap()
                }
            }, opts.startupMs)
        },
        onConnect: (): void => {
            seen = true
            count += 1
            // A live viewer (re)appeared: cancel both the startup backstop and any
            // pending grace timer so a reload's reconnect never trips the reap.
            clearStartup()
            clearGrace()
        },
        onDisconnect: (): void => {
            if (count > 0) {
                count -= 1
            }
            // Only arm the grace window once we've genuinely served someone and the
            // last of them has now dropped — a reload reconnects within `graceMs`.
            if (seen && count === 0) {
                clearGrace()
                graceTimer = opts.setTimer(() => {
                    if (count === 0) {
                        reap()
                    }
                }, opts.graceMs)
            }
        }
    }
}

/**
 * Resolve `file` to an absolute path and assert it is an existing `.mdx`/`.md`.
 *
 * Pure (a stat + extension check, no server side-effects) so it is exercised
 * directly in the spec. The thrown messages are `holo: error:`-shaped fragments
 * (the runner prefixes `holo: error:`), so a missing file or a non-MDX extension
 * fails the launch as exit 1 rather than booting a server pointed at nothing.
 *
 * @param file - the positional path to the plan source; resolved against cwd.
 * @returns the absolute path to the validated `.mdx`/`.md` file.
 * @throws {ServeError} if the path does not exist, is not a regular file, or has a non-MDX extension.
 *
 * @example
 * const abs = resolveMdxPath("plan.mdx") // => "/abs/cwd/plan.mdx"
 */
export const resolveMdxPath = (file: string): string => {
    const abs = path.resolve(file)
    const ext = path.extname(abs).toLowerCase()
    if (!MDX_EXTENSIONS.has(ext)) {
        throw new ServeError(`${file} is not a .mdx or .md file (got '${ext || "no extension"}').`)
    }
    let stat: fs.Stats
    try {
        stat = fs.statSync(abs)
    } catch {
        throw new ServeError(`${file} does not exist (resolved ${abs}).`)
    }
    if (!stat.isFile()) {
        throw new ServeError(`${file} is not a regular file (resolved ${abs}).`)
    }
    return abs
}

/**
 * Resolve `file` to an absolute path and assert it is an existing `.css`.
 *
 * The `--css` override sibling of {@link resolveMdxPath}: a pure stat + extension
 * check so a bad override fails the launch cleanly (exit 1) rather than booting a
 * page whose stylesheet 404s. `holo: error:`-shaped messages (the runner prefixes
 * `holo: error:`).
 *
 * @param file - the `--css` path; resolved against cwd.
 * @returns the absolute path to the validated `.css` file.
 * @throws {ServeError} if the path does not exist, is not a regular file, or is not `.css`.
 */
export const resolveCssPath = (file: string): string => {
    const abs = path.resolve(file)
    const ext = path.extname(abs).toLowerCase()
    if (ext !== ".css") {
        throw new ServeError(`${file} is not a .css file (got '${ext || "no extension"}').`)
    }
    let stat: fs.Stats
    try {
        stat = fs.statSync(abs)
    } catch {
        throw new ServeError(`${file} does not exist (resolved ${abs}).`)
    }
    if (!stat.isFile()) {
        throw new ServeError(`${file} is not a regular file (resolved ${abs}).`)
    }
    return abs
}

/**
 * Build the inline Vite dev config that serves the editable plan page.
 *
 * Pure (returns a plain config object, binds nothing) so the spec can assert its
 * shape without booting Vite. The page is a small React app (the committed `app/`
 * template) hosting an in-browser MDX editor; the plan text is NOT compiled by
 * Vite — the page fetches it from the `/__holo/plan` endpoint at runtime — so no
 * MDX rollup plugin or plan alias is needed here, only `react()` for the app shell.
 * The stylesheet is still aliased ({@link STYLE_ALIAS} → {@link DEFAULT_CSS} or the
 * `--css` override) so it themes the page chrome. `server.fs.allow` lists the app
 * root, the stylesheet's dir, and the repo root — Vite restricts file serving to
 * `root` by default, and the editor's own assets under `node_modules` (and any
 * `--css` override) live outside it, so those dirs must be allow-listed.
 *
 * @param options - the resolved launch knobs; see {@link ServeOptions}.
 * @returns a Vite {@link InlineConfig} with `configFile: false` (no file on disk) and `appType: "spa"`.
 *
 * @example
 * const config = buildViteConfig({ host: "127.0.0.1", port: 5173 })
 */
export const buildViteConfig = (options: ServeOptions): InlineConfig => {
    const cssPath = options.css !== undefined ? path.resolve(options.css) : DEFAULT_CSS
    const cssDir = path.dirname(cssPath)
    return {
        configFile: false,
        root: APP_ROOT,
        plugins: [react()],
        resolve: {
            alias: {
                // The stylesheet is aliased so `--css` swaps the file the page loads
                // without the entry import ever changing.
                [STYLE_ALIAS]: cssPath
            }
        },
        server: {
            host: options.host,
            // No strictPort — let Vite auto-bump to the next free port if taken.
            port: options.port,
            open: options.open,
            fs: {
                // Root-restricted by default; the editor's node_modules assets and any
                // `--css` override live outside the app root, so allow their dirs.
                allow: [APP_ROOT, cssDir, REPO_ROOT]
            }
        },
        appType: "spa"
    }
}

/**
 * Compute the local URL holo advertises, preferring Vite's own resolved URL.
 *
 * After `listen()` Vite knows the actually-bound port (it may have auto-bumped),
 * exposed via `resolvedUrls.local`. We take that when present; otherwise we
 * reconstruct `http://<host>:<port>` from the (possibly bumped) config port so
 * the banner still reports a usable address. Vite appends a trailing slash to
 * its resolved URL — we strip a single one so the banner reports the stable,
 * greppable `http://host:port` shape the spec pins (and that matches the dry-run
 * banner, which has no server to ask).
 *
 * @param server - the listening Vite dev server.
 * @param host - the requested host (the reconstruction fallback's host).
 * @returns the local URL string the banner reports (no trailing slash).
 */
export const resolveLocalUrl = (server: ViteDevServer, host: string): string => {
    const local = server.resolvedUrls?.local?.[0]
    if (local !== undefined) {
        return local.replace(/\/$/, "")
    }
    const port = server.config.server.port ?? 0
    return `http://${host}:${port}`
}

/** Minimal HTML-text escape for the injected `<title>` — filenames rarely need it, but be safe. */
const escapeHtmlText = (text: string): string =>
    text.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"))

/** The dev-server endpoint the page uses to read the plan (GET) and persist edits (POST). */
export const PLAN_ENDPOINT = "/__holo/plan"

/** The outcome of {@link handlePlanIo}: an HTTP status plus an optional text body/content-type. */
export type PlanIoResult = { status: number; body?: string; contentType?: string }

/**
 * Pure request logic for {@link PLAN_ENDPOINT}: `GET` reads the plan, `POST` writes
 * the request body back to it, anything else is `405`. Extracted from the live
 * middleware (which only adapts Node's req/res and the file I/O onto this) so the
 * spec drives it with fake I/O — no socket, no real file. The write is the whole
 * point: an edit made in the browser lands on the same file the agent reads.
 *
 * @param method - the request method (`req.method`).
 * @param readBody - reads the full request body as text; consulted on `POST` only.
 * @param io - the plan file's read/write side-effects, injected for testability.
 * @returns the status and optional body/content-type to write onto the response.
 */
export const handlePlanIo = async (
    method: string | undefined,
    readBody: () => Promise<string>,
    io: { read: () => Promise<string>; write: (text: string) => Promise<void> }
): Promise<PlanIoResult> => {
    if (method === "GET") {
        return { status: 200, body: await io.read(), contentType: "text/plain; charset=utf-8" }
    }
    if (method === "POST") {
        await io.write(await readBody())
        return { status: 204 }
    }
    return { status: 405 }
}

/** Read a Node request stream to a single UTF-8 string (the POSTed plan text). */
const readRequestBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        req.on("data", (chunk: Buffer) => chunks.push(chunk))
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
        req.on("error", reject)
    })

/**
 * Run the foreground server: validate the path, build the config, boot Vite in
 * dev/HMR mode, print the banner, and block until a signal.
 *
 * `server.listen()` and the shutdown block ride `effect()`, so `--dry-run`
 * rehearses the deterministic prelude — path validation, config build, the exact
 * `holo: ready` banner — and returns WITHOUT binding a port. On the real path,
 * SIGINT/SIGTERM `await server.close()` then unblock and exit cleanly. HMR is on
 * by default in dev mode and is deliberately left enabled.
 *
 * When `killOnDisconnect` is set, a {@link createDisconnectReaper} rides on Vite's
 * HMR websocket and funnels through the SAME shutdown path once the last viewer
 * drops (tab close / real reload past the grace window), so a hook-spawned server
 * self-cleans; without it the server stays persistent (manual `serve` unchanged).
 *
 * @param file - the positional path to the plan source `.mdx`/`.md`.
 * @param options - the resolved launch knobs; see {@link ServeOptions}.
 * @returns a promise that resolves when the server has stopped (immediately on dry-run).
 * @throws {ServeError} if the path is missing/invalid — the CLI maps it to exit 1.
 *
 * @example
 * await serve("plan.mdx", { host: "127.0.0.1", port: 5173 })
 */
export const serve = async (file: string, options: ServeOptions): Promise<void> => {
    const mdxPath = resolveMdxPath(file)
    // Validate the --css override up front (like the mdx path) so a bad path fails
    // the launch cleanly, even on --dry-run; buildViteConfig re-resolves it for the alias.
    if (options.css !== undefined) {
        resolveCssPath(options.css)
    }
    const config = buildViteConfig(options)

    // Title the tab after the loaded file (not hardcoded): a serve-time
    // transformIndexHtml that rewrites <title> to the plan's basename.
    const title = escapeHtmlText(path.basename(mdxPath))
    config.plugins = [
        ...(config.plugins ?? []),
        {
            name: "holo-title",
            transformIndexHtml: (html: string): string =>
                html.replace(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`)
        },
        {
            // Mount the endpoint the page's editor talks to: GET seeds it with the
            // file's current text, POST persists an edit back to the SAME file so the
            // on-disk plan stays canonical for the agent. The decision is pure
            // (handlePlanIo); this only adapts Node's req/res and the file I/O onto it.
            name: "holo-editor",
            configureServer(server: ViteDevServer): void {
                server.middlewares.use(PLAN_ENDPOINT, (req, res) => {
                    void handlePlanIo(req.method, () => readRequestBody(req), {
                        read: () => fs.promises.readFile(mdxPath, "utf8"),
                        write: (text) => fs.promises.writeFile(mdxPath, text)
                    })
                        .then((result) => {
                            res.statusCode = result.status
                            if (result.contentType !== undefined) {
                                res.setHeader("content-type", result.contentType)
                            }
                            res.end(result.body)
                        })
                        .catch((error) => {
                            res.statusCode = 500
                            res.end(String(error))
                        })
                })
            }
        }
    ]

    // The bind rides effect(): on dry-run it is skipped and resolves undefined,
    // so we report the requested URL for the banner without ever creating a
    // server or touching a port.
    const server = (await effect(() => createServer(config))) as ViteDevServer | undefined

    if (server === undefined) {
        // Dry-run: rehearse the banner from the requested host/port, bind nothing.
        process.stdout.write(`holo: ready url=http://${options.host}:${options.port} mdx=${mdxPath}\n`)
        return
    }

    await effect(() => server.listen())

    // Stable, greppable startup banner. KEEP THIS SHAPE STABLE (skills/specs grep it).
    const url = resolveLocalUrl(server, options.host)
    process.stdout.write(`holo: ready url=${url} mdx=${mdxPath}\n`)
    server.printUrls()

    // The dev server blocks; park until a signal (or, under --kill-on-disconnect,
    // the reaper), close cleanly ONCE, then unblock/exit.
    await effect(
        () =>
            new Promise<void>((resolve) => {
                let stopped = false
                // The single shutdown path: SIGINT/SIGTERM AND the disconnect reaper
                // both funnel here, so the server is closed exactly once.
                const shutdown = (): void => {
                    if (stopped) {
                        return
                    }
                    stopped = true
                    void server.close().then(() => resolve())
                }
                process.once("SIGINT", shutdown)
                process.once("SIGTERM", shutdown)

                if (options.killOnDisconnect) {
                    const reaper = createDisconnectReaper({
                        graceMs: DISCONNECT_GRACE_MS,
                        startupMs: STARTUP_TIMEOUT_MS,
                        onReap: shutdown,
                        setTimer: (fn, ms) => setTimeout(fn, ms),
                        clearTimer: (timer) => clearTimeout(timer)
                    })
                    // Vite 7's HMR ws server exposes the raw `ws` server's `on`, so
                    // "connection" delivers the raw socket and its "close" fires when
                    // that viewer drops (tab close / full reload). A steady-state HMR
                    // edit keeps the socket open, so it never trips this.
                    server.ws.on("connection", (socket) => {
                        reaper.onConnect()
                        socket.on("close", () => reaper.onDisconnect())
                    })
                    reaper.start()
                }
            })
    )
}

const command = defineCommand({
    name: "serve",
    description: "Serve a plan (.md/.mdx) as a live, editable page over HTTP — edit an agent's plan in the browser.",
    arguments: [{ name: "file", description: "path to the .mdx (or .md) plan to render", required: true }],
    options: [
        {
            name: "host",
            arity: 1,
            hint: "addr",
            description: "address the dev server binds to",
            defaultValue: () => "127.0.0.1"
        },
        {
            name: "port",
            arity: 1,
            hint: "n",
            description: "starting port; Vite auto-bumps if it's taken",
            coerce: integer,
            defaultValue: () => 5173
        },
        {
            name: "open",
            arity: 0,
            description: "open the page in the default browser on boot (Vite server.open)"
        },
        {
            name: "kill-on-disconnect",
            arity: 0,
            description:
                "exit when the last HMR client disconnects — used by the interactive plan hook so each spawned server self-cleans on tab close"
        },
        {
            name: "css",
            arity: 1,
            hint: "path",
            description: "override the page stylesheet with a .css file (default: holo's built-in style.css)"
        }
    ],
    run: async ({ file, host, port, open, css, "kill-on-disconnect": killOnDisconnect }) => {
        try {
            await serve(file, { host, port, open, css, killOnDisconnect })
        } catch (error) {
            if (error instanceof ServeError) {
                process.stderr.write(`holo: error: ${error.message}\n`)
                process.exit(1)
            }
            throw error
        }
    }
})

if (import.meta.main) {
    process.exit(await execute(command, { metadata: command }))
}
