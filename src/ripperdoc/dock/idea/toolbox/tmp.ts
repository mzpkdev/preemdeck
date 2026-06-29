/**
 * tmp.ts — temp-file minting for the inline / merge toolbox CLIs: a fresh,
 * uniquely-named file in the system temp dir whose name ENDS WITH the given
 * suffix (so the IDE picks the right syntax highlighting). Shared so
 * open-inline / diff-inline / merge-file / merge-inline mint temps identically.
 */

import { open, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Resolve `path` to an absolute, symlink-resolved path, THROWING when it does not
 * exist. realpath does both halves (resolves symlinks AND raises ENOENT on a
 * missing path); the thrown error carries a string `.code` ("ENOENT"), so the
 * CLIs' error handler catches it and exits 1.
 */
export const resolveStrict = async (path: string): Promise<string> => {
    return await realpath(path)
}

/**
 * Create a fresh empty temp file ending in `suffix` and return its path (the
 * handle is opened and immediately closed, leaving an empty file). The UUIDv4
 * filename guarantees uniqueness without racing — a flat file directly in
 * tmpdir(), so reapLater fully cleans it up (no per-call dir residue left behind).
 */
export const mkstemp = async (suffix = ".txt"): Promise<string> => {
    const path = join(tmpdir(), `idea-tmp-${crypto.randomUUID()}${suffix}`)
    // Create the file so it exists before we hand back the path.
    const handle = await open(path, "w")
    await handle.close()
    return path
}

/**
 * Spill `content` to a fresh temp file ending in `suffix` and return its path —
 * the open-inline / *-inline spill step (write the complete file before the IDE
 * opens it).
 */
export const writeTemp = async (content: string, suffix = ".txt"): Promise<string> => {
    const path = await mkstemp(suffix)
    await writeFile(path, content)
    return path
}
