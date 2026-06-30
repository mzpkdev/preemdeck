#!/usr/bin/env -S preemdeck-runtime
/**
 * devscripts/verify.ts — the preemdeck doctor: probe the installed CLIs and lint
 * our own source for drift, print a pass/fail report, and EXIT NONZERO on any
 * mismatch (so this can gate CI).
 *
 * Run it: `bun run verify` (which is `"$HOME/.preemdeck/preemdeck-runtime"
 * devscripts/verify.ts` — the same vendored-Bun shim every hook/plugin uses).
 *
 * Three families of checks, each a named {@link Check} returning ok/fail + detail:
 *
 *   A. Versions — `claude/codex/gemini --version`, each asserted ≥ a pinned floor
 *      ({@link MIN_VERSIONS}). A host whose CLI is ABSENT is reported "not
 *      installed" and does NOT fail the run — we only fail a host that's present
 *      but stale (or whose version we can't parse).
 *
 *   B. Command/flag presence — the live-CLI shape checks, run only for present
 *      hosts:
 *        · Gemini: `extensions install --help` MUST show a positional `<source>`
 *          and MUST NOT contain `--path` (the old install-by-path flag is gone).
 *        · Codex:  `plugin --help` MUST list `add` and `marketplace`.
 *        · Claude: `plugin --help` MUST list `install` and `marketplace`.
 *
 *   C. Source lint — scan our own tree ({@link LINT_GLOBS}) for a denylist of
 *      removed/renamed identifiers ({@link DENYLIST}) and fail with `file:line`
 *      on any hit.
 *
 * The CLI-probing and lint LOGIC is factored into pure functions
 * (`parseSemver`, `compareSemver`, `geminiInstallHelpOk`, `helpListsTokens`,
 * `scanText`) so the spec can exercise them against fixture strings without
 * shelling out. The async `run*` wrappers spawn the real CLI / read the real
 * files and delegate to those pure functions.
 */

import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { PIPED, reap } from "../src/common/process"

// devscripts/ sits at the repo root, so the root is this file's parent's parent.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = dirname(SCRIPT_DIR)

const PROBE_TIMEOUT_MS = 15_000

// ─── Types ──────────────────────────────────────────────────────────────────

/** A semantic version triplet. */
export type Semver = { major: number; minor: number; patch: number }

/** The outcome of a single named check. */
export type Check = {
    /** Stable, human-readable check name (e.g. "version:claude"). */
    name: string
    /** Pass/fail. A skipped-but-OK host (CLI absent) is `ok: true`. */
    ok: boolean
    /** One-line detail: the version found, the offending `file:line`, why it was skipped, etc. */
    detail: string
    /** True when the check was a graceful skip (host not installed) rather than a real pass. */
    skipped?: boolean
}

// ─── A. Versions ──────────────────────────────────────────────────────────────

/**
 * Minimum acceptable version per host CLI — the installed versions as the floor.
 * A present CLI below its floor fails; bumping a floor here tightens the gate.
 */
export const MIN_VERSIONS: Record<Host, Semver> = {
    claude: { major: 2, minor: 1, patch: 196 },
    codex: { major: 0, minor: 142, patch: 4 },
    gemini: { major: 0, minor: 49, patch: 0 }
}

/** The three hosts preemdeck overlays, in report order. */
export type Host = "claude" | "codex" | "gemini"
export const HOSTS: readonly Host[] = ["claude", "codex", "gemini"]

/**
 * Pull the first `x.y.z` semver out of arbitrary `--version` text, or null.
 *
 * Tolerant by design — the three CLIs print wildly different shapes:
 *   claude → "2.1.196 (Claude Code)"   codex → "codex-cli 0.142.4"   gemini → "0.49.0"
 * A leading "v" and any surrounding prose are ignored; only the first triplet matters.
 */
export const parseSemver = (text: string): Semver | null => {
    const m = text.match(/(\d+)\.(\d+)\.(\d+)/)
    if (m === null) return null
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

/** Compare two semvers: negative if a<b, 0 if equal, positive if a>b. */
export const compareSemver = (a: Semver, b: Semver): number =>
    a.major - b.major || a.minor - b.minor || a.patch - b.patch

/** Format a semver back to "x.y.z". */
export const formatSemver = (v: Semver): string => `${v.major}.${v.minor}.${v.patch}`

/**
 * Decide the version check for one host from its raw `--version` output.
 *
 * Pure — the spec feeds it fixture strings. `raw === null` means the CLI is
 * absent: a graceful skip (`ok: true, skipped: true`), NOT a failure. A present
 * CLI fails only when its version can't be parsed or is below {@link MIN_VERSIONS}.
 */
export const evaluateVersion = (host: Host, raw: string | null): Check => {
    const name = `version:${host}`
    const floor = MIN_VERSIONS[host]
    if (raw === null) {
        return { name, ok: true, skipped: true, detail: "not installed — skipped" }
    }
    const found = parseSemver(raw)
    if (found === null) {
        return { name, ok: false, detail: `could not parse version from ${JSON.stringify(raw.trim())}` }
    }
    if (compareSemver(found, floor) < 0) {
        return { name, ok: false, detail: `${formatSemver(found)} < required ${formatSemver(floor)}` }
    }
    return { name, ok: true, detail: `${formatSemver(found)} ≥ ${formatSemver(floor)}` }
}

// ─── B. Command/flag presence (pure parsers) ────────────────────────────────

/**
 * Whether `gemini extensions install --help` is in the post-rename shape:
 * a positional `<source>` is present AND the old `--path` flag is absent.
 * Both conditions must hold; either failing flips it false.
 */
export const geminiInstallHelpOk = (help: string): boolean => help.includes("<source>") && !help.includes("--path")

/**
 * Whether a subcommand-listing `--help` mentions every token in `tokens`.
 *
 * Word-boundary match so "add" doesn't spuriously hit inside "address" — we want
 * the standalone subcommand name as it appears in the command list.
 */
export const helpListsTokens = (help: string, tokens: readonly string[]): boolean =>
    tokens.every((tok) => new RegExp(`\\b${escapeRegExp(tok)}\\b`).test(help))

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// ─── C. Source lint ─────────────────────────────────────────────────────────

/**
 * Removed/renamed identifiers that must NOT appear in our tracked source. Each is
 * matched as a plain substring, so the `extensions install --path` entry catches
 * the exact stale Gemini invocation even though it spans spaces.
 */
export const DENYLIST: readonly string[] = [
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
    "TeamCreate",
    "TeamDelete",
    "save_memory",
    "plugin_hooks",
    "coreTools",
    "extensions install --path"
]

/**
 * Glob set (relative to {@link REPO_ROOT}) the source lint scans. Mirrors the
 * briefing: the whole overlay tree, the per-host imprint manifests, and install.ts.
 */
export const LINT_GLOBS: readonly string[] = [
    "src/overwrite/**",
    "src/ripperdoc/wetware/imprint/hosts/host_*.md",
    "install.ts"
]

/** A denylist hit: which term, which 1-based line, and the trimmed line text. */
export type Hit = { term: string; line: number; text: string }

/**
 * Scan `content` for every {@link DENYLIST} term, returning a {@link Hit} per
 * occurrence (term × line). Pure — the spec drives it with fixture strings.
 *
 * A term appearing twice on one line yields two hits; the same line matching two
 * terms yields one hit each. Lines are 1-based to match editor/`file:line` refs.
 */
export const scanText = (content: string, denylist: readonly string[] = DENYLIST): Hit[] => {
    const hits: Hit[] = []
    const lines = content.split("\n")
    for (let i = 0; i < lines.length; i++) {
        const text = lines[i] ?? ""
        for (const term of denylist) {
            let from = text.indexOf(term)
            while (from !== -1) {
                hits.push({ term, line: i + 1, text: text.trim() })
                from = text.indexOf(term, from + term.length)
            }
        }
    }
    return hits
}

// ─── Async runners (spawn / read real things; delegate to the pure logic) ────

/** Run `bin --version`; return trimmed stdout+stderr, or null when the binary is absent. */
const probeVersion = async (bin: string): Promise<string | null> => {
    try {
        const r = await reap(Bun.spawn([bin, "--version"], PIPED), PROBE_TIMEOUT_MS)
        if (r.timedOut) return null
        // Some CLIs print the version to stderr; fold both streams, take the first.
        const out = `${r.stdout}\n${r.stderr}`.trim()
        return out === "" ? null : out
    } catch {
        // Bun.spawn throws (ENOENT) when the binary isn't on PATH — treat as absent.
        return null
    }
}

/** Run an arbitrary `--help` argv; return trimmed stdout+stderr, or null if the binary is absent. */
const probeHelp = async (argv: string[]): Promise<string | null> => {
    try {
        const r = await reap(Bun.spawn(argv, PIPED), PROBE_TIMEOUT_MS)
        if (r.timedOut) return null
        return `${r.stdout}\n${r.stderr}`
    } catch {
        return null
    }
}

/** A-family: the three version checks. */
const runVersionChecks = async (): Promise<Check[]> => {
    const out: Check[] = []
    for (const host of HOSTS) {
        out.push(evaluateVersion(host, await probeVersion(host)))
    }
    return out
}

/** B-family: the live command/flag-presence checks, skipped gracefully per absent host. */
const runPresenceChecks = async (): Promise<Check[]> => {
    const out: Check[] = []

    // Gemini: extensions install must take a positional <source>, not --path.
    const gemini = await probeHelp(["gemini", "extensions", "install", "--help"])
    if (gemini === null) {
        out.push({ name: "flags:gemini-install", ok: true, skipped: true, detail: "gemini not installed — skipped" })
    } else {
        const ok = geminiInstallHelpOk(gemini)
        out.push({
            name: "flags:gemini-install",
            ok,
            detail: ok
                ? "extensions install takes positional <source>, no --path"
                : `expected positional <source> and no --path (saw <source>=${gemini.includes("<source>")}, --path=${gemini.includes("--path")})`
        })
    }

    // Codex: plugin command lists add + marketplace.
    const codex = await probeHelp(["codex", "plugin", "--help"])
    if (codex === null) {
        out.push({ name: "flags:codex-plugin", ok: true, skipped: true, detail: "codex not installed — skipped" })
    } else {
        const want = ["add", "marketplace"] as const
        const ok = helpListsTokens(codex, want)
        out.push({
            name: "flags:codex-plugin",
            ok,
            detail: ok ? "plugin lists add + marketplace" : `plugin --help missing ${missing(codex, want)}`
        })
    }

    // Claude: plugin command lists install + marketplace.
    const claude = await probeHelp(["claude", "plugin", "--help"])
    if (claude === null) {
        out.push({ name: "flags:claude-plugin", ok: true, skipped: true, detail: "claude not installed — skipped" })
    } else {
        const want = ["install", "marketplace"] as const
        const ok = helpListsTokens(claude, want)
        out.push({
            name: "flags:claude-plugin",
            ok,
            detail: ok ? "plugin lists install + marketplace" : `plugin --help missing ${missing(claude, want)}`
        })
    }

    return out
}

/** Comma-join the tokens NOT present in `help` (for a failing presence detail). */
const missing = (help: string, tokens: readonly string[]): string =>
    tokens.filter((tok) => !helpListsTokens(help, [tok])).join(", ")

/** C-family: one check, scanning every {@link LINT_GLOBS} file for the {@link DENYLIST}. */
const runSourceLint = async (): Promise<Check[]> => {
    const seen = new Set<string>()
    const hits: Hit[] = []
    for (const pattern of LINT_GLOBS) {
        const glob = new Bun.Glob(pattern)
        for await (const rel of glob.scan({ cwd: REPO_ROOT, onlyFiles: true, dot: true })) {
            if (seen.has(rel)) continue
            seen.add(rel)
            const text = await Bun.file(join(REPO_ROOT, rel)).text()
            for (const hit of scanText(text)) {
                hits.push({ ...hit, text: `${rel}:${hit.line}: ${hit.term}` })
            }
        }
    }
    if (hits.length === 0) {
        return [{ name: "lint:source", ok: true, detail: `no denylisted identifiers across ${seen.size} files` }]
    }
    return [
        {
            name: "lint:source",
            ok: false,
            detail: `${hits.length} denylisted identifier(s):\n${hits.map((h) => `      ${h.text}`).join("\n")}`
        }
    ]
}

// ─── Report ──────────────────────────────────────────────────────────────────

const PASS = "✔"
const FAIL = "✘"
const SKIP = "○"

/** Render the check list + a summary line. Returns the process exit code (0 / 1). */
export const report = (checks: Check[]): number => {
    const lines: string[] = ["preemdeck verify — doctor\n"]
    for (const c of checks) {
        const mark = c.skipped ? SKIP : c.ok ? PASS : FAIL
        lines.push(`  ${mark} ${c.name.padEnd(22)} ${c.detail}`)
    }
    const failed = checks.filter((c) => !c.ok)
    const skipped = checks.filter((c) => c.skipped)
    const passed = checks.length - failed.length - skipped.length
    lines.push("")
    lines.push(
        failed.length === 0
            ? `  ${PASS} all checks passed (${passed} ok, ${skipped.length} skipped)`
            : `  ${FAIL} ${failed.length} check(s) failed (${passed} ok, ${skipped.length} skipped): ${failed.map((c) => c.name).join(", ")}`
    )
    process.stdout.write(`${lines.join("\n")}\n`)
    return failed.length === 0 ? 0 : 1
}

/** Run every check family and return the flat list (test-friendly entrypoint). */
export const runAll = async (): Promise<Check[]> => [
    ...(await runVersionChecks()),
    ...(await runPresenceChecks()),
    ...(await runSourceLint())
]

if (import.meta.main) {
    process.exit(report(await runAll()))
}
