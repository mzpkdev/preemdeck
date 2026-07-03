/**
 * groovy.ts — shared ideScript bridge: escape a Groovy literal + run a one-shot
 * script.
 *
 * Neutral infra the in-IDE features build on, not tied to any one of them: escape
 * a string for safe embedding in a Groovy double-quoted literal, and run a
 * one-shot Groovy script against the live IntelliJ Platform API. The IDE binary
 * evaluates the script via `ideScript` (its output lands in idea.log); the script
 * reaches Groovy by spilling to a temp `.groovy`, blocking on the run, then
 * handing the temp to the deferred reaper. preview.ts and notify both layer
 * their templates on this bridge.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { IdeaError, NotImplementedError } from "./errors"
import { launch as defaultLaunch, type LaunchOptions } from "./launch"
import { reapLater as defaultReapLater } from "./reap"

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
 * preview helpers grew the same identical loop, so hoisting it here keeps the
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
 * The error categories runGroovy swallows: a missing live IDE (IdeaError), an
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
 * rather than racing the IDE's async read (mirrors open-inline.ts).
 *
 * A missing live IDE (IdeaError), an unimplemented platform
 * (NotImplementedError), or an OS error spawning the launcher is swallowed with
 * a `{note}` stderr line — the function never rejects. Callers that have a
 * fallback (setPreview) let the note stand; callers that don't (previewUrl via
 * open-url.ts) treat the note as a hard failure at the CLI boundary.
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
        // deferred reaper rather than racing the read (mirrors open-inline.ts).
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

/**
 * Sentinel a result script writes SYNCHRONOUSLY at its top, before its async EDT
 * body runs, so a compile failure is distinguishable from a slow launch.
 *
 * `webstorm ideScript` swallows a Groovy COMPILE error silently — no stderr, no
 * exit code — so a result file that never appears is otherwise ambiguous between
 * "didn't compile" and "still starting". A result script writes this marker up
 * front, then OVERWRITES it with the real answer from a `finally` on the EDT;
 * {@link runGroovyForResult} treats a file that still holds ONLY this marker as
 * "not answered yet" and keeps polling. A file that never even reaches the marker
 * (compile error / dead launcher) simply times out to null — the caller fails open.
 */
export const GROOVY_RESULT_PENDING = "__preemdeck_result_pending__"

/** Seams for {@link runGroovyForResult}: the runGroovyOn dispatch seams plus the result round-trip. */
export type RunGroovyForResultDeps = RunGroovyDeps & {
    /** Allocate the result-file path injected into the script (default: a fresh temp `.json`). */
    allocResultPath?: () => Promise<string>
    /** Read the result file; resolve to its text, or null when absent/unreadable. */
    readResult?: (path: string) => Promise<string | null>
    /** Total poll budget in ms before giving up on a target (default 4000). */
    timeoutMs?: number
    /** Delay between polls in ms (default 100). */
    pollIntervalMs?: number
    /** Sleep primitive between polls; injectable so tests don't actually wait (default: setTimeout). */
    delay?: (ms: number) => Promise<void>
}

const defaultAllocResultPath = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "idea-result-"))
    return join(dir, `${crypto.randomUUID()}.json`)
}

/** Read a result file's text, or null on ANY failure (not yet written, ENOENT, race). */
const defaultReadResult = async (path: string): Promise<string | null> => {
    try {
        return await readFile(path, "utf8")
    } catch {
        return null
    }
}

const defaultDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Poll `resultPath` until it holds a real answer or `timeoutMs` elapses.
 *
 * "Answered" means the file exists, is non-empty, and holds something OTHER than
 * {@link GROOVY_RESULT_PENDING} — so a script that compiled and started (marker
 * written) but hasn't finished its EDT write keeps the poll waiting rather than
 * returning the marker. Reads once before the deadline check, so a tiny timeout
 * still gives the file one chance; returns the trimmed answer or null on timeout.
 */
const pollResult = async (
    resultPath: string,
    timeoutMs: number,
    pollIntervalMs: number,
    delay: (ms: number) => Promise<void>,
    readResult: (path: string) => Promise<string | null>
): Promise<string | null> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        const text = await readResult(resultPath)
        if (text !== null) {
            const trimmed = text.trim()
            if (trimmed.length > 0 && trimmed !== GROOVY_RESULT_PENDING) {
                return trimmed
            }
        }
        if (Date.now() >= deadline) {
            return null
        }
        await delay(pollIntervalMs)
    }
}

/**
 * Run a result-producing script in the live IDE and round-trip its answer through
 * a temp file; resolve to the trimmed answer string, or null on timeout/miss.
 * NEVER rejects on a swallowable dispatch error.
 *
 * The READ sibling of {@link runGroovyOn} (which is fire-and-forget): a
 * focus/state read needs the IDE's answer back, but `ideScript` forwards to the
 * IDE asynchronously — it returns before the EDT body runs and swallows compile
 * errors — so there is no in-band return value. Instead we allocate a result-file
 * path, hand it to `buildGroovy(resultPath)` (the path is INJECTED into the
 * script, which writes its answer there), dispatch the script, and POLL the file.
 *
 * Per exec path (the caller filters to the launching product like renameTab, so
 * this is usually a single launcher): allocate a FRESH result path (so multiple
 * IDEs never race on one file), build + dispatch the script blocking via
 * `ideScript`, then {@link pollResult} up to `timeoutMs`. The FIRST path that
 * yields a non-pending answer wins and is returned; every path's temp script AND
 * result file are handed to the deferred reaper. A swallowable per-target dispatch
 * error degrades to a `{note}` stderr line (matching runGroovyOn) and the loop
 * continues; a non-swallowable error propagates. An empty `execPaths` returns null
 * without dispatching.
 *
 * `buildGroovy` is a function of the result path (rather than a plain `groovy`
 * string) precisely so the path can be injected type-safely — the script must
 * reference exactly the path we allocate, poll, and reap.
 */
export const runGroovyForResult = async (
    buildGroovy: (resultPath: string) => string,
    note: string,
    execPaths: readonly string[],
    deps: RunGroovyForResultDeps = {}
): Promise<string | null> => {
    const launch = deps.launch ?? defaultLaunch
    const reapLater = deps.reapLater ?? defaultReapLater
    const writeTemp = deps.writeTemp ?? defaultWriteTemp
    const warn = deps.warn ?? ((line: string) => process.stderr.write(line))
    const allocResultPath = deps.allocResultPath ?? defaultAllocResultPath
    const readResult = deps.readResult ?? defaultReadResult
    const timeoutMs = deps.timeoutMs ?? 4000
    const pollIntervalMs = deps.pollIntervalMs ?? 100
    const delay = deps.delay ?? defaultDelay

    for (const execPath of execPaths) {
        const resultPath = await allocResultPath()
        const script = await writeTemp(buildGroovy(resultPath))
        try {
            // Pin this launch to one product; ideScript returns before the EDT body runs.
            await launch(["ideScript", script], { wait: true, resolveExec: () => execPath })
            const answer = await pollResult(resultPath, timeoutMs, pollIntervalMs, delay, readResult)
            if (answer !== null) {
                return answer
            }
        } catch (err) {
            if (isSwallowable(err)) {
                const message = err instanceof Error ? err.message : String(err)
                warn(`${note} (${message})\n`)
            } else {
                throw err
            }
        } finally {
            reapLater([script, resultPath])
        }
    }
    return null
}
