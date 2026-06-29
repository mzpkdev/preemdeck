/**
 * codec.ts — shared persona obfuscation for the ghost plugin.
 *
 * A `.dat` file holds a persona's UTF-8 text inside a base64 ASCII envelope.
 * `encode`/`decode` round-trip that envelope; `readSource` reads a slot from a
 * root, preferring the decoded `.dat` and falling back to the plain `.md`.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { markdown } from "../../../../common/preemdeck"

/** UTF-8 text → base64 ASCII (a `.dat` payload). */
export const encode = (text: string): string => Buffer.from(text, "utf8").toString("base64")

/** base64 ASCII (a `.dat` payload) → the original UTF-8 text. */
export const decode = (b64: string): string => Buffer.from(b64, "base64").toString("utf8")

/**
 * Read a persona source from `root`: the base64 `.dat` (decoded) if present,
 * else the plain `.md`, else null.
 */
export const readSource = async (root: string, datName: string, mdName: string): Promise<string | null> => {
    const dat = join(root, datName)
    if (existsSync(dat)) return decode(await markdown.read(dat))
    const md = join(root, mdName)
    if (existsSync(md)) return await markdown.read(md)
    return null
}
