/**
 * _tmp.ts — temp-file minting for the inline / merge toolbox CLIs, matching
 * Python's `tempfile.mkstemp(suffix=...)` for the bits the callers depend on:
 * a fresh, uniquely-named file in the system temp dir whose name ENDS WITH the
 * given suffix (so the IDE picks the right syntax highlighting). Shared so
 * open_inline / diff_inline / merge_file / merge_inline mint temps identically.
 */

import { closeSync, mkdtempSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Resolve `path` to an absolute, symlink-resolved path, THROWING when it does not
 * exist — the diff/merge inputs' `Path(p).resolve(strict=True)`. realpathSync
 * matches both halves (resolves symlinks AND raises ENOENT on a missing path);
 * the thrown error carries a string `.code` ("ENOENT"), so the CLIs' OSError
 * handler catches it and exits 1, like Python's FileNotFoundError.
 */
export function resolveStrict(path: string): string {
  return realpathSync(path);
}

/**
 * Create a fresh empty temp file ending in `suffix` and return its path (the fd
 * is opened and immediately closed, like os.close(fd) after mkstemp). A
 * per-call private dir guarantees uniqueness without racing on the filename.
 */
export function mkstempSync(suffix = ".txt"): string {
  const dir = mkdtempSync(join(tmpdir(), "idea-tmp-"));
  const path = join(dir, `${crypto.randomUUID()}${suffix}`);
  // Match mkstemp: the file exists (created) before we hand back the path.
  closeSync(openSync(path, "w"));
  return path;
}

/**
 * Spill `content` to a fresh temp file ending in `suffix` and return its path —
 * the open_inline / *_inline spill step (write the complete file before the IDE
 * opens it). Mirrors mkstemp + fdopen(fd,"w").write(content).
 */
export async function writeTemp(content: string, suffix = ".txt"): Promise<string> {
  const path = mkstempSync(suffix);
  writeFileSync(path, content);
  return path;
}
