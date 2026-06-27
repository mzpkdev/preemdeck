#!/usr/bin/env bun
/**
 * trash.ts — prune dev-only paths from the deployed ~/.preemdeck clone.
 *
 * boot.sh runs this (via preemdeck-runtime) after vendoring Bun. It reads `.trash` at
 * the repo root — gitignore-style patterns, one per line, `#` comments and blanks
 * ignored — and `git sparse-checkout`s those paths out, keeping everything else.
 * The `/*` + `/.*` includes preserve every top-level entry (dotfiles included), so
 * `.trash` itself survives — it must never list itself.
 *
 * Denylist by design: a new runtime path ships by default; a missed dev file is
 * harmless (the inverse of .stage's allowlist, where a stray .ts in the host cache
 * is the harm). Best-effort — a git too old for sparse-checkout warns, never throws.
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { spawn } from "../source/common/proc.ts"

// Subprocess seam — tests override this to assert the git argv without spawning.
export const _internals = { spawn }

// devscripts/ sits at the repo root, so the root is this file's parent directory.
export const REPO_ROOT = dirname(import.meta.dir)
export const TRASH_FILE = ".trash"

/** Parse `.trash` contents into gitignore-style patterns (trim; drop blanks + `#` comments). */
export function parseTrash(content: string): string[] {
    return content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"))
}

/**
 * Build the `git sparse-checkout` argv tail for the given exclude patterns.
 *
 * `/*` + `/.*` keep every top-level entry (dotfiles included); each pattern is then
 * negated to carve the dev-only paths back out.
 */
export function sparseArgs(patterns: string[]): string[] {
    return ["sparse-checkout", "set", "--no-cone", "/*", "/.*", ...patterns.map((p) => `!${p}`)]
}

/**
 * Prune the clone at `repoRoot`: read `.trash`, sparse-checkout its patterns out.
 *
 * Missing or comment-only `.trash` is a no-op; a git failure warns but never throws,
 * so an old git just leaves the dev-only files in place.
 */
export async function applyTrash(repoRoot: string = REPO_ROOT): Promise<void> {
    const trashPath = join(repoRoot, TRASH_FILE)
    if (!existsSync(trashPath)) {
        return
    }
    const patterns = parseTrash(readFileSync(trashPath, "utf8"))
    if (patterns.length === 0) {
        return
    }
    try {
        const result = await _internals.spawn(["git", "-C", repoRoot, ...sparseArgs(patterns)], { timeoutMs: 10_000 })
        if (result.exitCode !== 0) {
            process.stderr.write("      ⚠ sparse-checkout unavailable — deployed tree keeps dev-only files\n")
        }
    } catch {
        process.stderr.write("      ⚠ sparse-checkout failed — deployed tree keeps dev-only files\n")
    }
}

if (import.meta.main) {
    await applyTrash()
}
