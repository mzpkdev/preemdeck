/**
 * statusline.spec.ts — pure decision helpers unit-tested directly; computeBadge
 * exercised against throwaway git repos (a "remote" + its clone) in a tmp dir, so
 * the fetch / cache-throttle / HEAD-compare path runs for real without touching
 * `~/.preemdeck`. `now` is injected so freshness is deterministic.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    branchForChannel,
    computeBadge,
    FETCH_TTL_MS,
    hasUpdate,
    isCacheFresh,
    readCache,
    render,
    type StatusCache,
    UPDATE_BADGE
} from "./statusline"

const context = describe

const sh = (cwd: string, args: string[]): string => {
    const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`)
    return r.stdout.toString().trim()
}

const initRepo = (dir: string): void => {
    mkdirSync(dir, { recursive: true })
    sh(dir, ["init", "-q"])
    sh(dir, ["config", "user.email", "t@example.com"])
    sh(dir, ["config", "user.name", "test"])
    sh(dir, ["config", "commit.gpgsign", "false"])
    sh(dir, ["checkout", "-q", "-b", "main"])
}

const commit = (dir: string, name: string): string => {
    writeFileSync(join(dir, name), `${name}\n`)
    sh(dir, ["add", "-A"])
    sh(dir, ["commit", "-q", "-m", `add ${name}`])
    return sh(dir, ["rev-parse", "HEAD"])
}

const seedCache = (root: string, cache: StatusCache): void => {
    mkdirSync(join(root, ".cache"), { recursive: true })
    writeFileSync(join(root, ".cache", "statusline.json"), JSON.stringify(cache))
}

const ZERO_SHA = "0000000000000000000000000000000000000000"

describe("statusline", () => {
    context("branchForChannel", () => {
        it("maps stable→stable and edge→main, exactly as boot.sh does", () => {
            expect(branchForChannel("stable")).toBe("stable")
            expect(branchForChannel("edge")).toBe("main")
        })
    })

    context("hasUpdate", () => {
        it("is true only when both SHAs are known and differ", () => {
            expect(hasUpdate("aaa", "bbb")).toBe(true)
            expect(hasUpdate("aaa", "aaa")).toBe(false)
            expect(hasUpdate("", "bbb")).toBe(false)
            expect(hasUpdate("aaa", "")).toBe(false)
            expect(hasUpdate("", "")).toBe(false)
        })
    })

    context("isCacheFresh", () => {
        const cache: StatusCache = { fetchedAt: 1_000, channel: "edge", remote: "abc" }
        it("is false with no cache", () => {
            expect(isCacheFresh(null, "edge", 1_000)).toBe(false)
        })
        it("is false for a different channel", () => {
            expect(isCacheFresh(cache, "stable", 1_000)).toBe(false)
        })
        it("is true within the TTL and false past it", () => {
            expect(isCacheFresh(cache, "edge", 1_000 + FETCH_TTL_MS - 1)).toBe(true)
            expect(isCacheFresh(cache, "edge", 1_000 + FETCH_TTL_MS)).toBe(false)
        })
    })

    context("render / UPDATE_BADGE", () => {
        it("renders the badge only when an update is pending", () => {
            expect(render(true)).toBe(UPDATE_BADGE)
            expect(render(false)).toBe("")
        })
        it("reuses preemclaud's badge glyph + label", () => {
            expect(UPDATE_BADGE).toContain("◈ /sys:update")
        })
    })

    context("readCache", () => {
        let dir = ""
        beforeEach(async () => {
            dir = await mkdtemp(join(tmpdir(), "preemdeck-sl-rc-"))
        })
        afterEach(async () => {
            await rm(dir, { recursive: true, force: true })
        })
        it("returns null for a missing or malformed file", async () => {
            expect(await readCache(join(dir, "nope.json"))).toBeNull()
            const bad = join(dir, "bad.json")
            writeFileSync(bad, "{ not json")
            expect(await readCache(bad)).toBeNull()
        })
        it("parses a well-formed cache", async () => {
            const good = join(dir, "good.json")
            writeFileSync(good, JSON.stringify({ fetchedAt: 5, channel: "edge", remote: "abc" }))
            expect(await readCache(good)).toEqual({ fetchedAt: 5, channel: "edge", remote: "abc" })
        })
    })

    context("computeBadge", () => {
        let base = ""
        let remote = ""
        let root = ""
        const NOW = 1_000_000

        beforeEach(async () => {
            base = await mkdtemp(join(tmpdir(), "preemdeck-sl-"))
            remote = join(base, "remote")
            root = join(base, "clone")
            initRepo(remote)
            commit(remote, "one")
            sh(remote, ["branch", "stable"]) // both channel branches exist on origin, at "one"
            sh(base, ["clone", "-q", remote, root])
        })
        afterEach(async () => {
            await rm(base, { recursive: true, force: true })
        })

        it("prints nothing when the root is not a git checkout", async () => {
            const bare = join(base, "not-a-repo")
            mkdirSync(bare)
            expect(await computeBadge(bare, "edge", NOW)).toBe("")
        })

        it("prints nothing when the checkout matches the channel tip", async () => {
            expect(await computeBadge(root, "edge", NOW)).toBe("")
        })

        it("shows the badge when the channel tip is ahead of the checkout", async () => {
            commit(remote, "two")
            expect(await computeBadge(root, "edge", NOW)).toBe(UPDATE_BADGE)
        })

        it("skips the fetch while the cache is fresh, comparing HEAD to the cached tip", async () => {
            // Fresh cache with a tip that differs from HEAD → badge, no network touched.
            seedCache(root, { fetchedAt: NOW, channel: "edge", remote: ZERO_SHA })
            expect(await computeBadge(root, "edge", NOW + 1)).toBe(UPDATE_BADGE)
        })

        it("clears the badge (without fetching) once HEAD catches up to the cached tip", async () => {
            const head = sh(root, ["rev-parse", "HEAD"])
            seedCache(root, { fetchedAt: NOW, channel: "edge", remote: head })
            expect(await computeBadge(root, "edge", NOW + 1)).toBe("")
        })

        it("falls back to a same-channel cached tip when the fetch fails", async () => {
            rmSync(remote, { recursive: true, force: true }) // origin gone → fetch fails
            // Stale cache (forces a fetch attempt) with a differing tip → badge from cache.
            seedCache(root, { fetchedAt: 0, channel: "edge", remote: ZERO_SHA })
            expect(await computeBadge(root, "edge", NOW)).toBe(UPDATE_BADGE)
        })

        it("prints nothing when the fetch fails and there is no usable cache", async () => {
            rmSync(remote, { recursive: true, force: true })
            expect(await computeBadge(root, "edge", NOW)).toBe("")
        })

        // --- the stable channel (branch `stable`), symmetric to edge/main above ---

        it("prints nothing on the stable channel when the checkout matches the stable tip", async () => {
            expect(await computeBadge(root, "stable", NOW)).toBe("")
        })

        it("shows the badge on the stable channel when the stable tip is ahead", async () => {
            sh(remote, ["checkout", "-q", "stable"])
            commit(remote, "two")
            sh(remote, ["checkout", "-q", "main"])
            expect(await computeBadge(root, "stable", NOW)).toBe(UPDATE_BADGE)
        })

        it("compares the two stable/edge channels independently in one checkout", async () => {
            sh(remote, ["checkout", "-q", "stable"]) // advance ONLY stable
            commit(remote, "two")
            sh(remote, ["checkout", "-q", "main"])
            expect(await computeBadge(root, "edge", NOW)).toBe("") // main unchanged → current
            expect(await computeBadge(root, "stable", NOW)).toBe(UPDATE_BADGE) // stable ahead → badge
        })

        // --- pinned checkouts: HEAD resolves to a commit whether it's a branch, a
        //     detached SHA, or a tag, so the SHA compare works the same for all three ---

        it("shows the badge when HEAD is a detached SHA behind the channel tip", async () => {
            const pinned = sh(root, ["rev-parse", "HEAD"]) // "one"
            commit(remote, "two") // channel tip moves on
            sh(root, ["checkout", "-q", "--detach", pinned]) // pin to an old SHA
            expect(await computeBadge(root, "edge", NOW)).toBe(UPDATE_BADGE)
        })

        it("prints nothing when HEAD is a detached SHA pinned exactly at the channel tip", async () => {
            commit(remote, "two")
            sh(root, ["fetch", "-q", "origin", "main"])
            sh(root, ["checkout", "-q", "--detach", sh(root, ["rev-parse", "FETCH_HEAD"])]) // pin AT the tip
            expect(await computeBadge(root, "edge", NOW)).toBe("")
        })

        it("shows the badge when HEAD is a tag behind the channel tip", async () => {
            sh(root, ["tag", "v0"]) // tag the current commit ("one")
            commit(remote, "two") // channel tip moves on
            sh(root, ["checkout", "-q", "v0"]) // check out the tag (detached at "one")
            expect(await computeBadge(root, "edge", NOW)).toBe(UPDATE_BADGE)
        })
    })
})
