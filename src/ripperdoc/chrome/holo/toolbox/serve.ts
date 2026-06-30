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

/** The repo root, allow-listed for file serving alongside the app root + the mdx dir. */
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..")

/** Stable id the entry imports; aliased to the resolved external `.mdx` so rollup transforms it. */
export const PLAN_ALIAS = "@holo-plan"

/** Extensions holo will render as MDX (`.md` is accepted and compiled by `@mdx-js/rollup` too). */
const MDX_EXTENSIONS = new Set([".mdx", ".md"])

/** Raised to fail the launch cleanly (exit 1) with a `holo: error:` message. */
export class ServeError extends Error {}

/** The launch knobs serve resolves; `open` is `undefined` when unset (pass-through to Vite). */
export type ServeOptions = {
    host: string
    port: number
    open?: boolean
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
                [PLAN_ALIAS]: mdxPath
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
                allow: [APP_ROOT, mdxDir, REPO_ROOT]
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

    // The dev server blocks; park until a signal, close cleanly, then unblock/exit.
    await effect(
        () =>
            new Promise<void>((resolve) => {
                let stopped = false
                const shutdown = (): void => {
                    if (stopped) {
                        return
                    }
                    stopped = true
                    void server.close().then(() => resolve())
                }
                process.once("SIGINT", shutdown)
                process.once("SIGTERM", shutdown)
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
        }
    ],
    run: async ({ file, host, port, open }) => {
        try {
            await serve(file, { host, port, open })
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
