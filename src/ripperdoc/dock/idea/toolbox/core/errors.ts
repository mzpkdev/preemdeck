/**
 * errors.ts — shared error type for the idea toolbox.
 *
 * `IdeaError` marks the one failure the toolbox's
 * resolution can hit: no running JetBrains IDE could be resolved. CLIs turn it
 * into a non-zero exit at their boundary; best-effort callers (setPreview /
 * previewUrl, via runGroovy) swallow it. A distinct class lets callers
 * `catch`/`instanceof` it without matching unrelated runtime errors.
 */

/** No running JetBrains IDE could be resolved. */
export class IdeaError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "IdeaError"
    }
}

/**
 * A platform entry point that isn't implemented yet (JS has no built-in for
 * this). Thrown by the Linux stub (idea-linux.ts) and swallowed alongside
 * IdeaError by runGroovy's graceful-degrade path, so it lives next to IdeaError
 * as a toolbox-shared type.
 */
export class NotImplementedError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "NotImplementedError"
    }
}
