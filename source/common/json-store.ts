/**
 * lib/json-store.ts — atomic JSON read/write for preemdeck.json mode-state.
 *
 * Byte-compatible with the reference `json.dumps` writer (`set_directive`):
 * `json.dumps(data, indent=2, ensure_ascii=False) + "\n"` written to `<path>.tmp`
 * then `os.replace(tmp, path)` — an atomic swap that never leaves a half-written
 * config. JS `JSON.stringify(data, null, 2) + "\n"` produces the same framing
 * (2-space indent, no trailing space, `:` + single space, no ASCII-escaping of
 * non-ASCII since stringify emits UTF-8).
 */

import { rename, writeFile } from "node:fs/promises"

/**
 * Atomically write `data` as pretty JSON to `path`: serialize with 2-space
 * indent + trailing newline, write a sibling `<path>.tmp`, then rename over the
 * target. The rename is atomic on the same filesystem, so a reader never sees a
 * partial file. Matches the reference `json.dumps` writer byte-for-byte.
 */
export const writeJson = async (path: string, data: unknown): Promise<void> => {
    const payload = `${JSON.stringify(data, null, 2)}\n`
    const tmp = `${path}.tmp`
    await writeFile(tmp, payload, "utf8")
    await rename(tmp, path)
}
