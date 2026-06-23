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

import * as ideaLinux from "./idea_linux.ts";
import * as ideaMac from "./idea_mac.ts";

type PlatformModule = {
  inIdea: () => boolean;
  resolveExecPath: () => string;
  resolveLogDir: () => string;
};

function pickPlatform(): PlatformModule {
  const platform = process.platform;
  if (platform === "darwin") {
    return ideaMac;
  }
  if (platform === "linux") {
    return ideaLinux;
  }
  throw new Error(`Only macOS and Linux are supported (got '${platform}')`);
}

const platformModule = pickPlatform();

/** True when this terminal was launched by a JetBrains IDE (per-OS). */
export function inIdea(): boolean {
  return platformModule.inIdea();
}

/** Absolute path to the JetBrains IDE binary this process is running inside (per-OS). */
export function resolveExecPath(): string {
  return platformModule.resolveExecPath();
}

/** Log dir of the IDE this process is running inside (per-OS). */
export function resolveLogDir(): string {
  return platformModule.resolveLogDir();
}

// Shared error types.
export { IdeaError, NotImplementedError } from "./_errors.ts";
// Shared ideScript bridge.
export { escapeGroovy, type RunGroovyDeps, runGroovy } from "./_groovy.ts";
// Cross-platform launch (resolves resolveExecPath lazily at call time — see
// _launch.ts — so the static import cycle with this module is import-safe).
export { type LaunchOptions, launch } from "./_launch.ts";
// Preview helpers (layer on the bridge).
export {
  HTML_PREVIEW_EXTS,
  previewUrl,
  setPreview,
  type WebpreviewOpenBodyOptions,
  webpreviewOpenBody,
} from "./_preview.ts";
// Deferred temp cleanup.
export { REAP_DELAY_MS, reapLater } from "./_reap.ts";
