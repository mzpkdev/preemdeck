#!/usr/bin/env -S preemdeck-runtime
/**
 * devscripts/format-on-edit.ts — format the file an agent just edited.
 *
 * SIDE-EFFECT PostToolUse / AfterTool hook (NOT a context injector — it does not
 * use source/common/hook's envelope). Wired into `.claude/settings.json`,
 * `.codex/config.toml`, and `.gemini/settings.json`. ALWAYS exits 0 — a
 * formatter failure warns on stderr but never blocks the agent's edit.
 *
 * Behaviour:
 *   1. read the hook JSON from stdin; non-object / invalid -> exit 0 no-op.
 *   2. extract the edited path from tool_input.{file_path,absolute_path,path}
 *      (Gemini uses a differing key, hence the probe order).
 *   3. resolve it; it must be an existing file UNDER the containment root
 *      (`devscripts/`'s grandparent — `$HOME` in the decoupled ~/.preemdeck layout,
 *      i.e. the `parents[2]` of the script). Outside -> no-op.
 *   4. map suffix -> formatter and run it (timeout, errors swallowed to stderr).
 *
 * Formatter map:
 *   .ts / .json                    -> the shipped Biome from the JS scaffold (`biome format --write`)
 *   .md / .markdown / .yml / .yaml -> Prettier (`prettier --write`)
 *
 * JSON key order: Biome preserves object key order and reproduces the existing
 * `json.dumps(indent=2)` framing byte-for-byte across all tracked manifests, so
 * `.json` folds into Biome (no dedicated format_json.ts). The install manifest +
 * marketplace ordering is load-bearing and is preserved — verified on all 33
 * tracked `*.json` files.
 */

import { existsSync } from "node:fs"
import { stat } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { PIPED, reap } from "../source/common/process.ts"

// Two distinct roots:
//   CONTAINMENT_ROOT — the file-safety boundary. An edited file must live under
//     it or we skip it. The boundary is `parents[2]` ($HOME in the decoupled
//     ~/.preemdeck layout, where the script lives at ~/.preemdeck/devscripts/).
//   REPO_ROOT — the cwd the formatters run in, so Prettier finds
//     `.prettierrc.json`/`.prettierignore` and Biome finds `biome.json`. Running
//     from `parents[2]` ($HOME) is latently wrong for tool config discovery (Biome
//     makes it a hard error when $HOME has its own biome.json — "nested root
//     configuration"), so we deliberately run from the repo root where the project
//     config lives.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(SCRIPT_DIR)
const CONTAINMENT_ROOT = dirname(REPO_ROOT)

// The scaffold's Biome binary, resolved relative to the script's own location.
// Falls back to `bun x @biomejs/biome` when node_modules isn't shipped alongside.
const BIOME_BIN = resolve(REPO_ROOT, "node_modules", ".bin", "biome")
// Lazy-init: the binary probe is async (no `existsSync`), and a top-level await
// at module load is disallowed — so the Biome command is resolved on demand
// inside `format()` instead of as a load-time const.
const biomeCmd = async (): Promise<string[]> =>
    existsSync(BIOME_BIN) ? [BIOME_BIN, "format", "--write"] : ["bun", "x", "@biomejs/biome", "format", "--write"]

// Suffixes routed to Biome; resolved via `biomeCmd()` at format time.
const BIOME_SUFFIXES = new Set([".ts", ".json"])

// The scaffold's Prettier binary, resolved relative to the script's own location.
// Falls back to `bun x prettier` when node_modules isn't shipped alongside.
const PRETTIER_BIN = resolve(REPO_ROOT, "node_modules", ".bin", "prettier")
// Lazy-init for the same reason as `biomeCmd` — the binary probe is async and a
// top-level await at module load is disallowed.
const prettierCmd = async (): Promise<string[]> =>
    existsSync(PRETTIER_BIN) ? [PRETTIER_BIN, "--write"] : ["bun", "x", "prettier", "--write"]

// Suffixes routed to Prettier; resolved via `prettierCmd()` at format time.
const PRETTIER_SUFFIXES = new Set([".md", ".markdown", ".yml", ".yaml"])

const FORMAT_TIMEOUT_MS = 30_000

/** Parse stdin as a JSON object. Empty/invalid/array/non-object -> null (no-op). */
const readPayload = async (stdin: { text(): Promise<string> }): Promise<Record<string, unknown> | null> => {
    let parsed: unknown
    try {
        const raw = await stdin.text()
        parsed = JSON.parse(raw)
    } catch {
        return null
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null
    }
    return parsed as Record<string, unknown>
}

/** Pull the edited file path out of tool_input, probing the per-host key variants. */
const extractFilePath = (payload: Record<string, unknown>): string | null => {
    const toolInput = payload.tool_input
    if (toolInput === null || typeof toolInput !== "object" || Array.isArray(toolInput)) {
        return null
    }
    const ti = toolInput as Record<string, unknown>
    for (const key of ["file_path", "absolute_path", "path"]) {
        const value = ti[key]
        if (typeof value === "string" && value) {
            return value
        }
    }
    return null
}

/** Resolve `filePath`; return it only if it's an existing file under the containment root. */
const resolveInsideRoot = async (filePath: string): Promise<string | null> => {
    const abs = resolve(filePath)
    if (!existsSync(abs) || !(await stat(abs)).isFile()) {
        return null
    }
    // relative(root, abs) escaping the root starts with ".." (or is absolute on a
    // different drive) — mirrors the reference path.relative_to(root) ValueError guard.
    const rel = relative(CONTAINMENT_ROOT, abs)
    if (rel === "" || rel.startsWith("..") || resolve(CONTAINMENT_ROOT, rel) !== abs) {
        return null
    }
    return abs
}

/** Extract the lowercased suffix (".ts", ".json", …) of a path, or "" if none. */
const suffix = (path: string): string => {
    const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
    const base = slash >= 0 ? path.slice(slash + 1) : path
    const dot = base.lastIndexOf(".")
    // A leading-dot dotfile (".bashrc") has no suffix, matching Path(...).suffix.
    if (dot <= 0) return ""
    return base.slice(dot).toLowerCase()
}

/** Run the suffix-matched formatter on `path`. Errors warn on stderr; never throws. */
const format = async (path: string): Promise<void> => {
    const sfx = suffix(path)
    let cmd: string[] | undefined
    if (BIOME_SUFFIXES.has(sfx)) {
        cmd = await biomeCmd()
    } else if (PRETTIER_SUFFIXES.has(sfx)) {
        cmd = await prettierCmd()
    }
    if (cmd === undefined) {
        return
    }
    const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1)
    try {
        const result = await reap(Bun.spawn([...cmd, path], { ...PIPED, cwd: REPO_ROOT }), FORMAT_TIMEOUT_MS)
        if (result.timedOut) {
            process.stderr.write(`format-on-edit: ${name}: timed out after ${FORMAT_TIMEOUT_MS}ms\n`)
        }
    } catch (exc) {
        process.stderr.write(`format-on-edit: ${name}: ${exc instanceof Error ? exc.message : String(exc)}\n`)
    }
}

/** Hook entrypoint. Always resolves (caller exits 0); a missing/bad input is a no-op. */
export const main = async (stdin: { text(): Promise<string> } = Bun.stdin): Promise<void> => {
    const payload = await readPayload(stdin)
    if (payload === null) return

    const filePath = extractFilePath(payload)
    if (filePath === null) return

    const path = await resolveInsideRoot(filePath)
    if (path === null) return

    await format(path)
}

/**
 * Test surface — the containment root, suffix→formatter maps, and the internal
 * helpers are re-exported so the unit tests can exercise them directly without
 * shelling out to a real formatter.
 */
export {
    BIOME_SUFFIXES,
    biomeCmd,
    CONTAINMENT_ROOT,
    extractFilePath,
    format,
    PRETTIER_SUFFIXES,
    prettierCmd,
    readPayload,
    resolveInsideRoot,
    suffix
}

if (import.meta.main) {
    await main()
    process.exit(0)
}
