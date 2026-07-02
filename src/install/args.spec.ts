/**
 * args.spec.ts — the two hand-rolled CLI parsers (install + update).
 *
 * captureExit drives the process.exit(2) bail-outs; the happy paths assert the parsed shape.
 */

import { describe, expect, it } from "bun:test"
import { parseInstallArgs, parseUpdateArgs } from "./args"
import { captureExit } from "./testkit"

const context = describe

describe("args", () => {
    context("parseInstallArgs", () => {
        it("parses harness + --dry-run", () => {
            expect(parseInstallArgs(["claude", "--dry-run"])).toEqual({ harnesses: ["claude"], dryRun: true })
            expect(parseInstallArgs(["gemini"])).toEqual({ harnesses: ["gemini"], dryRun: false })
        })

        it("no positionals -> empty harnesses (auto-detect), no exit", () => {
            expect(parseInstallArgs([])).toEqual({ harnesses: [], dryRun: false })
            expect(parseInstallArgs(["--dry-run"])).toEqual({ harnesses: [], dryRun: true })
        })

        it("accepts multiple explicit harnesses, in argv order", () => {
            expect(parseInstallArgs(["gemini", "claude"])).toEqual({ harnesses: ["gemini", "claude"], dryRun: false })
        })

        it("invalid harness choice -> exit 2", () => {
            const { code, stderr } = captureExit(() => parseInstallArgs(["bogus"]))
            expect(code).toBe(2)
            expect(stderr).toContain("invalid choice: 'bogus'")
        })

        it("unknown option -> exit 2", () => {
            const { code, stderr } = captureExit(() => parseInstallArgs(["claude", "--nope"]))
            expect(code).toBe(2)
            expect(stderr).toContain("install.ts:")
        })
    })

    context("parseUpdateArgs", () => {
        it("no args selects auto-detect (empty harnesses)", () => {
            expect(parseUpdateArgs([])).toEqual({ harnesses: [] })
        })

        it("accepts valid harness positionals", () => {
            expect(parseUpdateArgs(["claude", "gemini"])).toEqual({ harnesses: ["claude", "gemini"] })
        })

        it("rejects an invalid harness with exit 2", () => {
            const { code, stderr } = captureExit(() => parseUpdateArgs(["bogus"]))
            expect(code).toBe(2)
            expect(stderr).toContain("invalid choice: 'bogus'")
        })

        it("rejects any flag (no --dry-run: boot.sh's fetch + reset are not dry) with exit 2", () => {
            const { code, stderr } = captureExit(() => parseUpdateArgs(["--dry-run"]))
            expect(code).toBe(2)
            expect(stderr).toContain("update.ts:")
        })
    })
})
