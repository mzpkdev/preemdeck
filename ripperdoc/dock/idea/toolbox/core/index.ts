/**
 * index.ts — JetBrains IDE toolbox public API; delegates to the current
 * platform. Port of core/__init__.py.
 *
 * Re-exports the detection surface (inIdea, resolveExecPath, resolveLogDir) from
 * the matching per-OS module, plus the cross-platform launch() / reapLater()
 * helpers, the shared ideScript bridge (escapeGroovy / runGroovy), the preview
 * helpers, and the shared error types. Importing on an unsupported platform
 * throws (the analog of the Python ImportError).
 *
 * The per-OS pick is resolved at module load by `process.platform`; selecting an
 * unsupported OS throws immediately, before any detection function is reachable.
 */

import * as ideaLinux from "./idea-linux.ts";
import * as ideaMac from "./idea-mac.ts";

type PlatformModule = {
  inIdea: () => boolean;
  resolveExecPath: () => string;
  resolveLogDir: () => string;
};

const pickPlatform = (): PlatformModule => {
  const platform = process.platform;
  if (platform === "darwin") {
    return ideaMac;
  }
  if (platform === "linux") {
    return ideaLinux;
  }
  throw new Error(`Only macOS and Linux are supported (got '${platform}')`);
};

const platformModule = pickPlatform();

/** True when this terminal was launched by a JetBrains IDE (per-OS). */
export const inIdea = (): boolean => {
  return platformModule.inIdea();
};

/** Absolute path to the JetBrains IDE binary this process is running inside (per-OS). */
export const resolveExecPath = (): string => {
  return platformModule.resolveExecPath();
};

/** Log dir of the IDE this process is running inside (per-OS). */
export const resolveLogDir = (): string => {
  return platformModule.resolveLogDir();
};

/** Shared error types callers `catch`/`instanceof` across the toolbox. */
export { IdeaError, NotImplementedError } from "./errors.ts";
/** Shared ideScript bridge: escape a Groovy literal + run a one-shot script. */
export { escapeGroovy, type RunGroovyDeps, runGroovy } from "./groovy.ts";
/**
 * Cross-platform launch (resolves resolveExecPath lazily at call time — see
 * launch.ts — so the static import cycle with this module is import-safe).
 */
export { type LaunchOptions, launch } from "./launch.ts";
/** Preview helpers (layer on the bridge) for forcing a rendered preview / URL tab. */
export {
  HTML_PREVIEW_EXTS,
  previewUrl,
  setPreview,
  type WebpreviewOpenBodyOptions,
  webpreviewOpenBody,
} from "./preview.ts";
/** Deferred temp cleanup for the toolbox's fire-and-forget (no-wait) modes. */
export { REAP_DELAY_MS, reapLater } from "./reap.ts";
