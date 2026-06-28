/**
 * index.ts — JetBrains IDE toolbox public API; delegates to the current
 * platform.
 *
 * Re-exports the detection surface (inIdea, resolveExecPath, resolveLogDir) from
 * the matching per-OS module, plus the cross-platform launch() / reapLater()
 * helpers, the shared ideScript bridge (escapeGroovy / runGroovy), the preview
 * helpers, and the shared error types. Importing on an unsupported platform
 * throws.
 *
 * The per-OS pick is resolved at module load by `process.platform`; selecting an
 * unsupported OS throws immediately, before any detection function is reachable.
 */

import * as ideaLinux from "./idea-linux"
import * as ideaMac from "./idea-mac"

type PlatformModule = {
    inIdea: () => boolean
    resolveExecPath: () => Promise<string>
    resolveExecPaths: () => Promise<string[]>
    resolveLogDir: () => Promise<string>
}

const pickPlatform = (): PlatformModule => {
    const platform = process.platform
    if (platform === "darwin") {
        return ideaMac
    }
    if (platform === "linux") {
        return ideaLinux
    }
    throw new Error(`Only macOS and Linux are supported (got '${platform}')`)
}

const platformModule = pickPlatform()

/**
 * True when this terminal was launched by a JetBrains IDE (per-OS).
 *
 * `PREEMDECK_FORCE_IN_IDEA` overrides the detection BEFORE delegating to the
 * platform module (so it also short-circuits Linux's `NotImplementedError`):
 * `"1"`/`"true"` forces `true`, `"0"`/`"false"` forces `false`. Unset (or any
 * other value) falls through to the per-OS `inIdea()`. This is a CI-available
 * env affordance — not a code seam — letting tests force the gate either way.
 */
export const inIdea = (): boolean => {
    const forced = process.env.PREEMDECK_FORCE_IN_IDEA
    if (forced === "1" || forced === "true") {
        return true
    }
    if (forced === "0" || forced === "false") {
        return false
    }
    return platformModule.inIdea()
}

/** Absolute path to the JetBrains IDE binary this process is running inside (per-OS). */
export const resolveExecPath = async (): Promise<string> => {
    return await platformModule.resolveExecPath()
}

/** Absolute paths to EVERY running JetBrains IDE launcher (the `notify --all` broadcast set, per-OS). */
export const resolveExecPaths = async (): Promise<string[]> => {
    return await platformModule.resolveExecPaths()
}

/** Log dir of the IDE this process is running inside (per-OS). */
export const resolveLogDir = async (): Promise<string> => {
    return await platformModule.resolveLogDir()
}

/** Shared error types callers `catch`/`instanceof` across the toolbox. */
export { IdeaError } from "./errors"
/** Shared ideScript bridge: escape a Groovy literal, target the terminal's window, run a one-shot script (against the ancestry IDE, or every running IDE via runGroovyOn). */
export { escapeGroovy, groovyProjectByCwd, runGroovy, runGroovyOn } from "./groovy"
/**
 * Cross-platform launch (resolves resolveExecPath lazily at call time — see
 * launch.ts — so the static import cycle with this module is import-safe).
 */
export { launch } from "./launch"
/** Preview helpers (layer on the bridge) for forcing a rendered preview / URL tab. */
export { previewUrl, setPreview, webpreviewOpenBody } from "./preview"
/** Deferred temp cleanup for the toolbox's fire-and-forget (no-wait) modes. */
export { reapLater } from "./reap"
