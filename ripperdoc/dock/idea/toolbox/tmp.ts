/**
 * tmp.ts — temp-file minting for the inline / merge toolbox CLIs, matching
 * the original `tempfile.mkstemp(suffix=...)` for the bits the callers depend on:
 * a fresh, uniquely-named file in the system temp dir whose name ENDS WITH the
 * given suffix (so the IDE picks the right syntax highlighting). Shared so
 * open_inline / diff_inline / merge_file / merge_inline mint temps identically.
 */

import { open, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Resolve `path` to an absolute, symlink-resolved path, THROWING when it does not
 * exist — the diff/merge inputs' `Path(p).resolve(strict=True)`. realpath
 * matches both halves (resolves symlinks AND raises ENOENT on a missing path);
 * the thrown error carries a string `.code` ("ENOENT"), so the CLIs' OSError
 * handler catches it and exits 1, like the original's FileNotFoundError.
 */
export const resolveStrict = async (path: string): Promise<string> => {
    return await realpath(path)
}

/**
 * Create a fresh empty temp file ending in `suffix` and return its path (the fd
 * is opened and immediately closed, like os.close(fd) after mkstemp). The UUIDv4
 * filename guarantees uniqueness without racing — a flat file directly in
 * tmpdir(), so reapLater fully cleans it up (no per-call dir residue left behind).
 */
export const mkstemp = async (suffix = ".txt"): Promise<string> => {
    const path = join(tmpdir(), `idea-tmp-${crypto.randomUUID()}${suffix}`)
    // Match mkstemp: the file exists (created) before we hand back the path.
    const handle = await open(path, "w")
    await handle.close()
    return path
}

/**
 * Spill `content` to a fresh temp file ending in `suffix` and return its path —
 * the open_inline / *_inline spill step (write the complete file before the IDE
 * opens it). Mirrors mkstemp + fdopen(fd,"w").write(content).
 */
export const writeTemp = async (content: string, suffix = ".txt"): Promise<string> => {
    const path = await mkstemp(suffix)
    await writeFile(path, content)
    return path
}
