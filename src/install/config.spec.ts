/**
 * config.spec.ts — preemdeck.json seeding suite (seed-if-absent, never clobber, dry-run).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { seedConfig } from "./config"
import { CONFIG_FILE, DEFAULT_CONFIG } from "./constants"

const context = describe

let dir = ""

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "preemdeck-config-"))
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

describe("config", () => {
    context("seedConfig", () => {
        it("writes preemdeck.json with the built-in defaults when absent", () => {
            seedConfig(dir, false)
            expect(readFileSync(join(dir, CONFIG_FILE), "utf8")).toBe(DEFAULT_CONFIG)
        })

        it("never overwrites an existing preemdeck.json", () => {
            writeFileSync(join(dir, CONFIG_FILE), '{"directive":{"strategy":"solo"}}\n')
            seedConfig(dir, false)
            expect(readFileSync(join(dir, CONFIG_FILE), "utf8")).toBe('{"directive":{"strategy":"solo"}}\n')
        })

        it("dry-run does not write", () => {
            seedConfig(dir, true)
            expect(existsSync(join(dir, CONFIG_FILE))).toBe(false)
        })
    })
})
