import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ENV } from "./preemdeck"

/**
 * Host-agnostic per-session turn counter backing {@link throttle}.
 *
 * The old throttle parsed Claude's `.jsonl` transcript to count user prompts —
 * Codex/Gemini use a different schema, so it failed open and injected on every
 * turn there. Instead we keep a tiny integer counter per session under
 * `~/.preemdeck/.state/<key>` and inject on a cadence boundary. The hook stdin
 * `session_id` (present on all three hosts, see how-to-create-hooks/HOOK_CONTRACT.md)
 * is the session key; env vars and finally `ppid:cwd` are fallbacks so a missing
 * id degrades to a stable per-process-tree counter rather than crashing.
 */

/** `~/.preemdeck/.state` — resolved per call so an ENV.PREEMDECK_ROOT override (tests) is honored. */
const stateDir = (): string => join(ENV.PREEMDECK_ROOT, ".state")

/**
 * A stable, filesystem-safe filename for `key`. The raw key is host-supplied
 * (a `session_id`, or `ppid:cwd`) and could contain path separators, so it's
 * hashed — the digest can't traverse out of the state dir and collides only on
 * a genuine SHA-256 clash.
 */
const keyFile = (key: string): string => join(stateDir(), createHash("sha256").update(key).digest("hex").slice(0, 32))

/**
 * Derive the session key from the hook payload, then env, then a process-tree
 * fallback. `session_id` rides every host's hook stdin; `*_SESSION_ID` env vars
 * cover a few hosts; `ppid:cwd` is the last resort so concurrent unrelated
 * sessions still get distinct counters and nothing ever throws.
 */
export const sessionKey = (payload: Record<string, unknown>): string => {
    const fromPayload = payload.session_id
    if (typeof fromPayload === "string" && fromPayload.length > 0) return fromPayload
    const env = process.env
    const fromEnv = env.CLAUDE_SESSION_ID || env.GEMINI_SESSION_ID || env.CODEX_SESSION_ID
    if (fromEnv) return fromEnv
    return `pid:${process.ppid}:${process.cwd()}`
}

/** Read the current count for `file`; 0 when absent or unparseable. */
const readCount = (file: string): number => {
    try {
        const n = Number.parseInt(readFileSync(file, "utf8"), 10)
        return Number.isInteger(n) && n >= 0 ? n : 0
    } catch {
        return 0
    }
}

/**
 * Persist `count` to `file` as atomically as a hook can manage: write a
 * pid-tagged temp sibling, then rename it over the target (rename is atomic on a
 * POSIX filesystem). Concurrent hook invocations may still interleave their
 * read-modify-write — that's tolerated, worst case is one extra or skipped inject,
 * never a crash. The temp tag keeps two racing writers off the same temp path.
 */
const writeCount = (file: string, count: number): void => {
    try {
        mkdirSync(stateDir(), { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        writeFileSync(tmp, String(count))
        renameSync(tmp, file)
    } catch {
        // A read-only or racing filesystem must not break the hook; skip persistence.
    }
}

/**
 * Whether this turn is a cadence boundary for its session: true on turn `first`,
 * then every `every`th after (`count >= first && (count - first) % every === 0`).
 * Increments the session's counter as a side effect. `every` is clamped to >= 1
 * (so `every === 1` fires every turn from `first` on) and `first` to >= 1 (turn
 * counts are 1-based); turns before `first` never fire. With the default
 * `first === 1` this is the 1st turn then every Nth. Never throws — any IO failure
 * falls back to firing (the safe default, matching the old fail-open behavior).
 */
export const throttle = (payload: Record<string, unknown>, every: number, first = 1): boolean => {
    const step = Math.max(1, every)
    const start = Math.max(1, first)
    try {
        const file = keyFile(sessionKey(payload))
        const count = readCount(file) + 1
        writeCount(file, count)
        return count >= start && (count - start) % step === 0
    } catch {
        return true
    }
}
