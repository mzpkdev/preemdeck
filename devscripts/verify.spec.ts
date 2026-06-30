import { describe, expect, test } from "bun:test"
import {
    compareSemver,
    DENYLIST,
    evaluateVersion,
    formatSemver,
    geminiInstallHelpOk,
    helpListsTokens,
    MIN_VERSIONS,
    parseSemver,
    report,
    scanText
} from "./verify"

// ─── A. Version parsing / comparison ──────────────────────────────────────────

describe("parseSemver", () => {
    test("pulls the triplet from each CLI's real --version shape", () => {
        expect(parseSemver("2.1.196 (Claude Code)")).toEqual({ major: 2, minor: 1, patch: 196 })
        expect(parseSemver("codex-cli 0.142.4")).toEqual({ major: 0, minor: 142, patch: 4 })
        expect(parseSemver("0.49.0")).toEqual({ major: 0, minor: 49, patch: 0 })
    })

    test("tolerates a leading v and surrounding prose", () => {
        expect(parseSemver("version v1.2.3 build 9")).toEqual({ major: 1, minor: 2, patch: 3 })
    })

    test("returns null when there's no triplet", () => {
        expect(parseSemver("")).toBeNull()
        expect(parseSemver("no version here")).toBeNull()
        expect(parseSemver("1.2")).toBeNull() // a two-part version is not a triplet
    })
})

describe("compareSemver", () => {
    test("orders by major, then minor, then patch", () => {
        // biome-ignore lint/style/noNonNullAssertion: fixtures are hardcoded valid triplets
        const v = (s: string) => parseSemver(s)!
        expect(compareSemver(v("1.0.0"), v("2.0.0"))).toBeLessThan(0)
        expect(compareSemver(v("1.2.0"), v("1.1.9"))).toBeGreaterThan(0)
        expect(compareSemver(v("1.1.1"), v("1.1.2"))).toBeLessThan(0)
        expect(compareSemver(v("1.1.1"), v("1.1.1"))).toBe(0)
        // patch is numeric, not lexical: 196 > 99
        expect(compareSemver(v("2.1.196"), v("2.1.99"))).toBeGreaterThan(0)
    })
})

describe("evaluateVersion", () => {
    test("absent CLI is a graceful skip, not a failure", () => {
        const c = evaluateVersion("gemini", null)
        expect(c.ok).toBe(true)
        expect(c.skipped).toBe(true)
        expect(c.detail).toMatch(/not installed/)
    })

    test("present CLI at exactly the floor passes", () => {
        const claude = evaluateVersion("claude", `${formatSemver(MIN_VERSIONS.claude)} (Claude Code)`)
        expect(claude.ok).toBe(true)
        expect(claude.skipped).toBeUndefined()
    })

    test("present CLI above the floor passes", () => {
        expect(evaluateVersion("codex", "codex-cli 0.200.0").ok).toBe(true)
    })

    test("present CLI below the floor fails with a clear detail", () => {
        const c = evaluateVersion("claude", "2.1.195 (Claude Code)")
        expect(c.ok).toBe(false)
        expect(c.detail).toContain("< required")
    })

    test("unparseable version of a present CLI fails", () => {
        const c = evaluateVersion("gemini", "garbage output")
        expect(c.ok).toBe(false)
        expect(c.detail).toMatch(/could not parse/)
    })
})

// ─── B. Command/flag presence parsers ─────────────────────────────────────────

describe("geminiInstallHelpOk", () => {
    const POST_RENAME = [
        "gemini extensions install <source> [--auto-update] [--pre-release]",
        "Positionals:",
        "  source  The github URL or local path of the extension to install.  [string] [required]"
    ].join("\n")

    test("passes on the post-rename help (positional <source>, no --path)", () => {
        expect(geminiInstallHelpOk(POST_RENAME)).toBe(true)
    })

    test("fails when the stale --path flag is present", () => {
        const stale = `${POST_RENAME}\n  --path  Local path to the extension`
        expect(geminiInstallHelpOk(stale)).toBe(false)
    })

    test("fails when the positional <source> is missing", () => {
        expect(geminiInstallHelpOk("gemini extensions install [--auto-update]")).toBe(false)
    })
})

describe("helpListsTokens", () => {
    const CODEX = "Commands:\n  add          Install a plugin\n  marketplace  Add, list, upgrade marketplaces"
    const CLAUDE = "Commands:\n  install|i [options] <plugin>   Install a plugin\n  marketplace   Manage marketplaces"

    test("passes when every token is listed (codex)", () => {
        expect(helpListsTokens(CODEX, ["add", "marketplace"])).toBe(true)
    })

    test("passes when every token is listed (claude)", () => {
        expect(helpListsTokens(CLAUDE, ["install", "marketplace"])).toBe(true)
    })

    test("fails when a token is absent", () => {
        expect(helpListsTokens(CODEX, ["add", "marketplace", "nonexistent"])).toBe(false)
    })

    test("matches on word boundaries — 'add' does not hit inside 'address'", () => {
        expect(helpListsTokens("the address book", ["add"])).toBe(false)
    })
})

// ─── C. Source lint ───────────────────────────────────────────────────────────

describe("scanText", () => {
    test("finds nothing in clean text", () => {
        expect(scanText("export const ok = true\nconst more = 1\n")).toEqual([])
    })

    test("reports each denylisted identifier with its 1-based line", () => {
        const fixture = [
            "line one is clean",
            '"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",', // line 2
            "still clean",
            "plugin_hooks = true" // line 4
        ].join("\n")
        const hits = scanText(fixture)
        const byTerm = Object.fromEntries(hits.map((h) => [h.term, h.line]))
        expect(byTerm.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe(2)
        expect(byTerm.plugin_hooks).toBe(4)
        expect(hits).toHaveLength(2)
    })

    test("catches the multi-word `extensions install --path` literal", () => {
        const hits = scanText("run: gemini extensions install --path ./ext")
        expect(hits).toHaveLength(1)
        expect(hits[0]?.term).toBe("extensions install --path")
        expect(hits[0]?.line).toBe(1)
    })

    test("reports the renamed team identifiers and the gemini memory tool", () => {
        const fixture = "TeamCreate / TeamDelete removed v2.1.178\nsave_memory was removed\ncoreTools: []"
        const terms = scanText(fixture)
            .map((h) => h.term)
            .sort()
        expect(terms).toEqual(["TeamCreate", "TeamDelete", "coreTools", "save_memory"].sort())
    })

    test("a term twice on one line yields two hits", () => {
        const hits = scanText("coreTools and coreTools again")
        expect(hits).toHaveLength(2)
        expect(hits.every((h) => h.line === 1)).toBe(true)
    })

    test("the denylist covers exactly the seven known-removed identifiers", () => {
        expect([...DENYLIST].sort()).toEqual(
            [
                "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
                "TeamCreate",
                "TeamDelete",
                "save_memory",
                "plugin_hooks",
                "coreTools",
                "extensions install --path"
            ].sort()
        )
    })
})

// ─── Report / exit code ───────────────────────────────────────────────────────

describe("report", () => {
    test("returns exit code 0 when nothing failed (skips are not failures)", () => {
        const code = report([
            { name: "version:claude", ok: true, detail: "ok" },
            { name: "version:gemini", ok: true, skipped: true, detail: "not installed — skipped" }
        ])
        expect(code).toBe(0)
    })

    test("returns exit code 1 when any check failed", () => {
        const code = report([
            { name: "version:claude", ok: true, detail: "ok" },
            { name: "lint:source", ok: false, detail: "1 denylisted identifier(s)" }
        ])
        expect(code).toBe(1)
    })
})
