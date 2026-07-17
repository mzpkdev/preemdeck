#!/usr/bin/env -S preemdeck-runtime
/**
 * statusline.ts — the preemdeck update badge for the Claude Code status line.
 *
 * The ONLY thing this status line adds: a badge when the installed preemdeck
 * checkout (`~/.preemdeck`) is behind its upstream channel — i.e. `/sys:update`
 * has something to pull. Current / not-installed / offline all print nothing, so
 * the status line stays empty until an update is actually waiting.
 *
 * Source of truth is preemdeck's OWN update model (not preemclaud's sentinel
 * scheme — only its badge display is reused). `~/.preemdeck` is the git checkout
 * boot.sh fetches into, and an update IS `git fetch <channel-branch>` +
 * `reset --hard FETCH_HEAD`. So "something to pull" ⟺ the local HEAD differs from
 * the channel branch tip on origin. The channel is read from preemdeck.json and
 * mapped to a branch EXACTLY as boot.sh maps it (stable→`stable`, edge→`main`,
 * default stable).
 *
 * A status line renders far too often to hit the network every time, so the fetch
 * is throttled to {@link FETCH_TTL_MS} via `~/.preemdeck/.cache/statusline.json`. The
 * cache is keyed on the local HEAD as well as the channel, so a checkout change (e.g.
 * right after /sys:update) invalidates a still-fresh cache and re-fetches at once — the
 * badge clears the moment an update lands instead of lingering until the TTL ages out.
 * Every failure path is fail-safe: print "" and never crash the bar.
 *
 * `${CLAUDE_PLUGIN_ROOT}` is NOT available to a status-line command, so the overlay
 * settings.json wires this by absolute `$HOME/.preemdeck/...` path through the
 * runtime shim — the same convention the directive hook uses.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { type Channel, config, ENV } from "../../../../common/preemdeck"
import { PIPED, reap } from "../../../../common/process"

const YELLOW = "\x1b[93m"
const RESET = "\x1b[0m"

/** The update badge — reused verbatim from preemclaud's status line (glyph + label + colour). */
export const UPDATE_BADGE = `${YELLOW}◈ /sys:update${RESET}`

/** How long a fetched channel tip stays fresh — a status line renders far too often to fetch each time. */
export const FETCH_TTL_MS = 30 * 60 * 1000

/** Throttle state persisted between renders: when we last fetched, for which channel, at which local HEAD, and the tip we saw. */
export type StatusCache = { fetchedAt: number; channel: string; remote: string; local: string }

/** boot.sh's channel→branch map: stable tracks the `stable` branch, edge tracks `main`. */
export const branchForChannel = (channel: Channel): string => (channel === "edge" ? "main" : "stable")

/**
 * A cached fetch is reusable only while within the TTL, for the same channel, AND at the
 * same local HEAD. Keying on HEAD means a checkout change (e.g. right after /sys:update)
 * invalidates a still-fresh cache, so the next render re-fetches instead of comparing the
 * new HEAD against a tip captured at the old one.
 */
export const isCacheFresh = (
    cache: StatusCache | null,
    channel: string,
    local: string,
    now: number,
    ttlMs: number = FETCH_TTL_MS
): boolean => cache !== null && cache.channel === channel && cache.local === local && now - cache.fetchedAt < ttlMs

/** Something to pull ⟺ both SHAs are known and the local checkout differs from the channel tip. */
export const hasUpdate = (localSha: string, remoteSha: string): boolean =>
    localSha !== "" && remoteSha !== "" && localSha !== remoteSha

/** The status-line body: the badge when an update is pending, else empty. */
export const render = (update: boolean): string => (update ? UPDATE_BADGE : "")

/** `git -C <root> <args>` → trimmed stdout on exit 0, else null. Never throws. */
const git = async (root: string, args: string[], timeoutMs: number): Promise<string | null> => {
    try {
        const r = await reap(Bun.spawn(["git", "-C", root, ...args], PIPED), timeoutMs)
        return r.exitCode === 0 ? r.stdout.trim() : null
    } catch {
        return null
    }
}

/** Read + validate the throttle cache; null on a missing/malformed file. */
export const readCache = async (file: string): Promise<StatusCache | null> => {
    try {
        const data = (await Bun.file(file).json()) as Partial<StatusCache>
        if (
            typeof data.fetchedAt === "number" &&
            typeof data.channel === "string" &&
            typeof data.remote === "string" &&
            typeof data.local === "string"
        ) {
            return { fetchedAt: data.fetchedAt, channel: data.channel, remote: data.remote, local: data.local }
        }
    } catch {
        // missing / unreadable / not JSON — treat as no cache
    }
    return null
}

/** Persist the throttle cache (Bun.write creates `.cache/`); best-effort, never throws. */
const writeCache = async (file: string, cache: StatusCache): Promise<void> => {
    try {
        await Bun.write(file, JSON.stringify(cache))
    } catch {
        // a read-only checkout just means we fetch again next render
    }
}

/**
 * The full check for one render: resolve the channel tip (throttled fetch, else
 * cached), compare it to the local HEAD, and return the badge or "". `root` is the
 * preemdeck checkout and `channel` its tracked stream; both are injected so this is
 * testable against a throwaway repo without touching `~/.preemdeck`.
 */
export const computeBadge = async (root: string, channel: Channel, now: number): Promise<string> => {
    // Not a git checkout → preemdeck wasn't installed via boot.sh; nothing to check.
    if (!existsSync(join(root, ".git"))) return ""

    // HEAD first: the cache is keyed on it, so a checkout change (e.g. right after
    // /sys:update) invalidates a still-fresh cache and forces the re-fetch below.
    const local = await git(root, ["rev-parse", "HEAD"], 2_000)
    if (!local) return ""

    const branch = branchForChannel(channel)
    const cacheFile = join(root, ".cache", "statusline.json")
    const cache = await readCache(cacheFile)

    let remote: string | null = null
    if (isCacheFresh(cache, channel, local, now)) {
        remote = cache?.remote ?? null
    } else {
        // Mirror boot.sh's fetch (shallow, the channel branch) and read its tip.
        if ((await git(root, ["fetch", "--depth", "1", "--quiet", "origin", branch], 5_000)) !== null) {
            remote = await git(root, ["rev-parse", "FETCH_HEAD"], 2_000)
            if (remote) await writeCache(cacheFile, { fetchedAt: now, channel, remote, local })
        }
        // Fetch failed (offline): reuse the cached tip only if the checkout is unchanged
        // since that fetch, so we never compare against a tip taken at a different HEAD.
        if (remote === null && cache?.channel === channel && cache.local === local) remote = cache.remote
    }
    if (!remote) return ""

    return render(hasUpdate(local, remote))
}

if (import.meta.main) {
    let out = ""
    try {
        // Channel is sticky in preemdeck.json (install.ts persists it); default stable,
        // exactly as boot.sh does when it's unset. Any read error falls through to stable.
        let channel: Channel = "stable"
        try {
            const cfg = await config.read()
            if (cfg.channel === "edge" || cfg.channel === "stable") channel = cfg.channel
        } catch {
            // unreadable/malformed config → stable
        }
        out = await computeBadge(ENV.PREEMDECK_ROOT, channel, Date.now())
    } catch {
        out = ""
    }
    process.stdout.write(out)
    process.exit(0)
}
