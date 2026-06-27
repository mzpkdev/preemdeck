/**
 * groovy.ts — shared ideScript bridge: escape a Groovy literal + run a one-shot
 * script. Port of core/_groovy.py.
 *
 * Neutral infra the in-IDE features build on, not tied to any one of them: escape
 * a string for safe embedding in a Groovy double-quoted literal, and run a
 * one-shot Groovy script against the live IntelliJ Platform API. The IDE binary
 * evaluates the script via `ideScript` (its output lands in idea.log); the script
 * reaches Groovy by spilling to a temp `.groovy`, blocking on the run, then
 * handing the temp to the deferred reaper. _preview and notify both layer their
 * templates on this bridge.
 */

import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { IdeaError, NotImplementedError } from "./errors.ts"
import { launch as defaultLaunch, type LaunchOptions } from "./launch.ts"
import { reapLater as defaultReapLater } from "./reap.ts"

/**
 * Escape `literal` for safe embedding inside a Groovy double-quoted string.
 *
 * Backslashes first (so an escaped quote's backslash isn't re-escaped), then
 * double quotes — the same rule the path literals use, hoisted out so the URL
 * and tab-title templates share one escaper.
 */
export const escapeGroovy = (literal: string): string => {
    return literal.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}

/**
 * Splice controls for {@link groovyProjectByCwd}: the bound variable, the
 * no-match fallback, the projects-array and cwd-literal names already in scope,
 * and the indent to align the block at its nesting level. All default so a
 * top-level `projects`/`cwd` scope needs only the indent.
 */
export type ProjectByCwdOptions = {
    /** Name to bind the selected project to. Default `project`. */
    varName?: string
    /**
     * Value when `cwd` matches no open project — `projects[0]` (the default) when
     * a concrete project is required (preview's FileEditorManager), or `null` for
     * an application-level target (notify's balloon, routed to the focused frame).
     */
    fallback?: string
    /** Name of the in-scope open-projects array to scan. Default `projects`. */
    projectsVar?: string
    /** Name of the in-scope (already-escaped) cwd String literal to match. Default `cwd`. */
    cwdVar?: string
    /** Prefixed to every line so the block aligns when spliced into a deeper nesting level. */
    indent?: string
}

/**
 * Groovy that binds `varName` to the open project whose basePath is the longest
 * prefix of `cwdVar` — the window the terminal sits in — scanning `projectsVar`.
 *
 * The SINGLE SOURCE OF TRUTH for "target the terminal's window": notify and the
 * preview helpers grew the same byte-for-byte loop, so hoisting it here keeps the
 * targeting from drifting between them. Emits ONLY the selection — from the
 * `def <varName> = <fallback>` line through the loop; the caller declares
 * `def <projectsVar> = ...getOpenProjects()` and the escaped `def <cwdVar> = "..."`
 * beforehand and reads `varName` after. No trailing newline (the caller's template
 * supplies it). `indent` prefixes every line for a deeper nesting level.
 */
export const groovyProjectByCwd = (options: ProjectByCwdOptions = {}): string => {
    const varName = options.varName ?? "project"
    const fallback = options.fallback ?? "projects[0]"
    const projectsVar = options.projectsVar ?? "projects"
    const cwdVar = options.cwdVar ?? "cwd"
    const indent = options.indent ?? ""
    const body = `def ${varName} = ${fallback}
def bestLen = -1
${projectsVar}.each { p ->
    def bp = p.getBasePath()
    if (bp != null && (${cwdVar} == bp || ${cwdVar}.startsWith(bp + "/")) && bp.length() > bestLen) {
        ${varName} = p
        bestLen = bp.length()
    }
}`
    if (indent === "") {
        return body
    }
    return body
        .split("\n")
        .map((line) => indent + line)
        .join("\n")
}

/** Seams for hermetic tests; production uses the real launch/reaper/FS. */
export type RunGroovyDeps = {
    launch?: (args: string[], options?: LaunchOptions) => Promise<Bun.Subprocess>
    reapLater?: (paths: Iterable<string>) => void
    /** Spill `groovy` to a temp `.groovy` and return its path. */
    writeTemp?: (groovy: string) => Promise<string>
    /** stderr sink for the swallowed-failure note. Default: process.stderr.write. */
    warn?: (line: string) => void
}

const defaultWriteTemp = async (groovy: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "idea-groovy-"))
    const script = join(dir, `${crypto.randomUUID()}.groovy`)
    await writeFile(script, groovy)
    return script
}

/**
 * The error categories run_groovy swallows: a missing live IDE (IdeaError), an
 * unimplemented platform (NotImplementedError), or an OS error spawning the
 * launcher (a Node system error carries a string `.code` like "ENOENT"). Any
 * other throwable propagates (it's a real bug, not a degrade case).
 */
const isSwallowable = (err: unknown): boolean => {
    if (err instanceof IdeaError || err instanceof NotImplementedError) {
        return true
    }
    return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string"
}

/**
 * Run a one-shot `groovy` script in the live IDE; never reject.
 *
 * The shared scaffolding behind setPreview/previewUrl: spill `groovy` to a temp
 * `.groovy`, run it via `launch(["ideScript", script], {wait: true})` (block
 * until the IDE has evaluated it), then hand the temp to the deferred reaper
 * rather than racing the IDE's async read (mirrors open_inline).
 *
 * A missing live IDE (IdeaError), an unimplemented platform
 * (NotImplementedError), or an OS error spawning the launcher is swallowed with
 * a `{note}` stderr line — the function never rejects. Callers that have a
 * fallback (setPreview) let the note stand; callers that don't (previewUrl via
 * open_url) treat the note as a hard failure at the CLI boundary.
 */
export const runGroovy = async (groovy: string, note: string, deps: RunGroovyDeps = {}): Promise<void> => {
    const launch = deps.launch ?? defaultLaunch
    const reapLater = deps.reapLater ?? defaultReapLater
    const writeTemp = deps.writeTemp ?? defaultWriteTemp
    const warn = deps.warn ?? ((line: string) => process.stderr.write(line))

    const script = await writeTemp(groovy)
    try {
        try {
            await launch(["ideScript", script], { wait: true })
        } catch (err) {
            if (isSwallowable(err)) {
                const message = err instanceof Error ? err.message : String(err)
                warn(`${note} (${message})\n`)
            } else {
                throw err
            }
        }
    } finally {
        // ideScript forwards to the running IDE async; hand the temp to the
        // deferred reaper rather than racing the read (mirrors open_inline).
        reapLater([script])
    }
}

/**
 * Run the SAME one-shot `groovy` against EACH of `execPaths` in turn; never reject.
 *
 * The broadcast sibling of {@link runGroovy} (which hits only the ancestry binary):
 * `notify --all` resolves every running JetBrains launcher and dispatches the same
 * script to each, so one balloon pops per running IDE. The temp `.groovy` is
 * written ONCE and reused across launches (each pinned to its product via
 * `resolveExec`), then handed to the deferred reaper exactly once.
 *
 * Per target the swallow rules match runGroovy: a missing/again-resolved launcher
 * (IdeaError), an unimplemented platform (NotImplementedError), or an OS spawn
 * error degrades to a `{note}` stderr line and the loop continues to the next IDE;
 * any other throwable propagates (a real bug). An empty `execPaths` is a no-op
 * dispatch (the temp is still written and reaped).
 */
export const runGroovyOn = async (
    groovy: string,
    note: string,
    execPaths: readonly string[],
    deps: RunGroovyDeps = {}
): Promise<void> => {
    const launch = deps.launch ?? defaultLaunch
    const reapLater = deps.reapLater ?? defaultReapLater
    const writeTemp = deps.writeTemp ?? defaultWriteTemp
    const warn = deps.warn ?? ((line: string) => process.stderr.write(line))

    const script = await writeTemp(groovy)
    try {
        for (const execPath of execPaths) {
            try {
                // Pin this launch to one product (no ancestry walk); same script, same temp.
                await launch(["ideScript", script], { wait: true, resolveExec: () => execPath })
            } catch (err) {
                if (isSwallowable(err)) {
                    const message = err instanceof Error ? err.message : String(err)
                    warn(`${note} (${message})\n`)
                } else {
                    throw err
                }
            }
        }
    } finally {
        reapLater([script])
    }
}
