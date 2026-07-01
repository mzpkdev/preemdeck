#!/usr/bin/env bun
/**
 * serve.ts — the FOREGROUND holo server (blocking).
 *
 * Serve a rendered MDX plan as a live page over HTTP — a browser view of an
 * agent's plan. Resolves + validates the target `.mdx`, builds an inline Vite
 * dev config (no vite.config on disk) that aliases the external file in as
 * `@holo-plan` so `@mdx-js/rollup` transforms it, boots Vite in dev/HMR mode,
 * prints the greppable `holo: ready` banner, and blocks until a signal.
 *
 * The deterministic prelude (resolve + validate the path, build the config,
 * would-print the banner) is pure and unit-testable; only the real side-effects
 * — `server.listen()` and the shutdown block — ride `effect()`, so `--dry-run`
 * rehearses the whole prelude WITHOUT binding a port.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import mdx from "@mdx-js/rollup"
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

/** Stable id the entry imports; aliased to the resolved external `.mdx` so rollup transforms it. */
export const PLAN_ALIAS = "@holo-plan"

/** Stable id the entry imports for its stylesheet; aliased to {@link DEFAULT_CSS} or the `--css` override. */
export const STYLE_ALIAS = "@holo-style"

/** Extensions holo will render as MDX (`.md` is accepted and compiled by `@mdx-js/rollup` too). */
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
 * Build the inline Vite dev config that renders `mdxPath` as a live MDX→React page.
 *
 * Pure (returns a plain config object, binds nothing) so the spec can assert its
 * shape without booting Vite. The external `.mdx` lives anywhere on disk, so it
 * is fed in via a `resolve.alias` mapping {@link PLAN_ALIAS} → its absolute path;
 * because the resolved id ends in `.mdx`/`.md`, `@mdx-js/rollup` transforms it,
 * and `react()` wires Fast Refresh so editing the source hot-updates the page.
 * `server.fs.allow` lists the app root, the mdx's own directory, AND the repo
 * root — Vite restricts file serving to `root` by default, and the aliased
 * external file lives outside it, so its dir must be allow-listed.
 *
 * @param mdxPath - absolute path to the validated `.mdx`/`.md` (see {@link resolveMdxPath}).
 * @param options - the resolved launch knobs; see {@link ServeOptions}.
 * @returns a Vite {@link InlineConfig} with `configFile: false` (no file on disk) and `appType: "spa"`.
 *
 * @example
 * const config = buildViteConfig("/abs/plan.mdx", { host: "127.0.0.1", port: 5173 })
 */
export const buildViteConfig = (mdxPath: string, options: ServeOptions): InlineConfig => {
    const mdxDir = path.dirname(mdxPath)
    const cssPath = options.css !== undefined ? path.resolve(options.css) : DEFAULT_CSS
    const cssDir = path.dirname(cssPath)
    return {
        configFile: false,
        root: APP_ROOT,
        // mdx BEFORE react so `.mdx`→JSX flows through Fast Refresh; `jsxImportSource`
        // pins the runtime so the compiled MDX resolves `jsx`/`jsxs` from react.
        plugins: [mdx({ jsxImportSource: "react" }), react()],
        resolve: {
            // The arbitrary external plan is pulled in under a stable id; its `.mdx`
            // extension is what makes `@mdx-js/rollup` pick it up.
            alias: {
                [PLAN_ALIAS]: mdxPath,
                // The stylesheet is aliased the same way, so `--css` swaps the file the
                // page loads without the entry import ever changing.
                [STYLE_ALIAS]: cssPath
            }
        },
        server: {
            host: options.host,
            // No strictPort — let Vite auto-bump to the next free port if taken.
            port: options.port,
            open: options.open,
            fs: {
                // Root-restricted by default; the aliased external file lives outside
                // the app root, so allow its dir (and the repo root) explicitly.
                allow: [APP_ROOT, mdxDir, cssDir, REPO_ROOT]
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
    const config = buildViteConfig(mdxPath, options)

    // Title the tab after the loaded file (not hardcoded): a serve-time
    // transformIndexHtml that rewrites <title> to the plan's basename.
    const title = escapeHtmlText(path.basename(mdxPath))
    config.plugins = [
        ...(config.plugins ?? []),
        {
            name: "holo-title",
            transformIndexHtml: (html: string): string =>
                html.replace(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`)
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
    description: "Serve a rendered MDX plan as a live page over HTTP — a browser view of an agent's plan.",
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
