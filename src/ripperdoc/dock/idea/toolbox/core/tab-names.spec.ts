/**
 * tab-names.spec.ts — the persisted stable-tab-id -> slug store.
 *
 * Every case injects the backing `file` (a throwaway temp path) so nothing touches
 * the real ~/.preemdeck. Covers the get/set/clear round trip under BOTH key shapes
 * the feature uses — a non-tmux controlling-tty key (`ttys006`) and a tmux session
 * key (`work`) — read-modify-write isolation across keys, the empty-key / empty-slug
 * no-ops, and the never-throw reads over a missing or malformed file. savedNamesPath
 * is checked to sit under ENV.PREEMDECK_ROOT.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ENV } from "../../../../../common/preemdeck"
import { clearSavedName, getSavedName, savedNamesPath, setSavedName } from "./tab-names"

const context = describe

let dir = ""
let file = ""
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "preemdeck-tabnames-"))
    file = join(dir, "tab-names.json")
})
afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

describe("tab-names store", () => {
    context("the non-tmux controlling-tty key (ttys006)", () => {
        it("round-trips set -> get -> clear -> get for a tty key", () => {
            expect(getSavedName("ttys006", file)).toBeUndefined()
            setSavedName("ttys006", "auth-retry", file)
            expect(getSavedName("ttys006", file)).toBe("auth-retry")
            clearSavedName("ttys006", file)
            expect(getSavedName("ttys006", file)).toBeUndefined()
        })

        it("persists the slug to disk as a { key: slug } JSON map", async () => {
            setSavedName("ttys006", "flaky-ci", file)
            const onDisk = JSON.parse(await readFile(file, "utf8"))
            expect(onDisk).toEqual({ ttys006: "flaky-ci" })
        })

        it("overwrites the slug for an existing tty key", () => {
            setSavedName("ttys006", "first", file)
            setSavedName("ttys006", "second", file)
            expect(getSavedName("ttys006", file)).toBe("second")
        })
    })

    context("the tmux session key (work)", () => {
        it("round-trips under a session-name key just like a tty key", () => {
            setSavedName("work", "tab-naming", file)
            expect(getSavedName("work", file)).toBe("tab-naming")
            clearSavedName("work", file)
            expect(getSavedName("work", file)).toBeUndefined()
        })
    })

    context("isolation across keys (read-modify-write)", () => {
        it("keeps other keys when setting a new one", () => {
            setSavedName("ttys006", "one", file)
            setSavedName("work", "two", file)
            expect(getSavedName("ttys006", file)).toBe("one")
            expect(getSavedName("work", file)).toBe("two")
        })

        it("clears only the target key, leaving the rest", () => {
            setSavedName("ttys006", "one", file)
            setSavedName("work", "two", file)
            clearSavedName("ttys006", file)
            expect(getSavedName("ttys006", file)).toBeUndefined()
            expect(getSavedName("work", file)).toBe("two")
        })
    })

    context("empty key / empty slug are no-ops", () => {
        it("get on an empty key is undefined", () => {
            expect(getSavedName("", file)).toBeUndefined()
        })
        it("set with an empty key does not write the file", async () => {
            setSavedName("", "slug", file)
            expect(await Bun.file(file).exists()).toBe(false)
        })
        it("set with an empty slug does not store the key", () => {
            setSavedName("ttys006", "", file)
            expect(getSavedName("ttys006", file)).toBeUndefined()
        })
        it("clear on an empty key is a silent no-op", () => {
            expect(() => clearSavedName("", file)).not.toThrow()
        })
    })

    context("robust reads (never throw)", () => {
        it("returns undefined for a missing file", () => {
            expect(getSavedName("ttys006", join(dir, "nope.json"))).toBeUndefined()
        })
        it("returns undefined over a malformed file rather than throwing", async () => {
            await writeFile(file, "}{ not json")
            expect(getSavedName("ttys006", file)).toBeUndefined()
        })
        it("ignores a non-string / empty value in the map", async () => {
            await writeFile(file, JSON.stringify({ ttys006: 42, ttys007: "", ttys008: "ok" }))
            expect(getSavedName("ttys006", file)).toBeUndefined()
            expect(getSavedName("ttys007", file)).toBeUndefined()
            expect(getSavedName("ttys008", file)).toBe("ok")
        })
        it("clear over a missing file does not throw", () => {
            expect(() => clearSavedName("ttys006", join(dir, "nope.json"))).not.toThrow()
        })
    })

    context("savedNamesPath (the default backing file)", () => {
        it("resolves to tab-names.json under ENV.PREEMDECK_ROOT", () => {
            const restore = Object.getOwnPropertyDescriptor(ENV, "PREEMDECK_ROOT")
            Object.defineProperty(ENV, "PREEMDECK_ROOT", { configurable: true, get: () => "/tmp/pd-root" })
            try {
                expect(savedNamesPath()).toBe(join("/tmp/pd-root", "tab-names.json"))
            } finally {
                if (restore) Object.defineProperty(ENV, "PREEMDECK_ROOT", restore)
            }
        })
    })
})
