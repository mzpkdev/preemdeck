/**
 * Async filesystem helpers. `node:fs/promises` has no `existsSync` equivalent,
 * so `exists` is the awaited 1:1 replacement used across the toolbox — true if
 * the path resolves (file or directory), false on any access error. It is a
 * faithful mirror of `existsSync`, not a "just try the real op and catch"
 * restructure, so call sites convert mechanically: `existsSync(p)` -> `await exists(p)`.
 */
import { access } from "node:fs/promises";

/** True if `path` exists (file or directory), false on any access error. */
export const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};
