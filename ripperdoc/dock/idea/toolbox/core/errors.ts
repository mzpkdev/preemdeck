/**
 * errors.ts — shared error type for the idea toolbox.
 *
 * Port of core/_errors.py. `IdeaError` marks the one failure the toolbox's
 * resolution can hit: no running JetBrains IDE could be resolved. CLIs turn it
 * into a non-zero exit at their boundary; best-effort callers (set_preview /
 * preview_url, via run_groovy) swallow it. A distinct class lets callers
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
 * A platform entry point that isn't implemented yet — the analog of Python's
 * built-in `NotImplementedError` (which has no JS equivalent). Thrown by the
 * Linux stub (idea_linux) and swallowed alongside IdeaError by run_groovy's
 * graceful-degrade path, so it lives next to IdeaError as a toolbox-shared type.
 */
export class NotImplementedError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "NotImplementedError"
    }
}
