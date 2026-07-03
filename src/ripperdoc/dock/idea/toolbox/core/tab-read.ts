/**
 * tab-read.ts — "what does the terminal TAB this shell runs in currently show as
 * its title?", read back from the live JetBrains IDE by process id.
 *
 * The read counterpart of core/tab.ts's rename and the persistence replacement for
 * the old tab-names.json store: instead of remembering the chosen name on disk, the
 * name lives in the IDE tab itself, and this reads it back. tab-title uses it to
 * recover the label base for a glyph flip (the model's / user's chosen name,
 * glyph-stripped), so a name set by rename-tab OR from the IDE's own tab menu both
 * survive the idle/busy/waiting flips.
 *
 * The tab is found exactly as rename-tab finds it: {@link resolveTabPids} lists the
 * pids on this shell's tty (login shell + any tmux client), and the Groovy matches
 * the one terminal Content whose backend process pid is one of them (pids are
 * globally unique). The heavy reflection — walk each open project's Terminal tool
 * window, resolve each Content's view and backend pid — is the SHARED chain from
 * core/tab-groovy.ts ({@link GROOVY_TAB_HELPERS}: `viewOf` + `pidOf`), so it never
 * drifts from the rename path. The title read is `Content.getDisplayName()` — the
 * text the tab actually shows (our `◐ base`, an IDE-menu rename, or the auto-name).
 *
 * FAIL-OPEN, NEVER THROWS. No pid on this tty, no live IDE, no matching tab, a
 * dispatch/timeout/parse miss — every undetermined case resolves to null, and the
 * caller falls back (tab-title to the project label). The JSON is
 * {@link GROOVY_RESULT_PENDING}-guarded so a swallowed compile error is a null miss,
 * not a stale read.
 */

import { escapeGroovy, GROOVY_RESULT_PENDING, type RunGroovyForResultDeps, runGroovyForResult } from "./groovy"
import { filterExecsForLaunchingProduct, resolveExecPaths } from "./index"
import { GROOVY_TAB_HELPERS } from "./tab-groovy"

/**
 * Build the one-shot Groovy that finds the terminal Content whose backend pid is in
 * `pids` and writes its displayed title as JSON to `resultPath`.
 *
 * Pure — takes the pid set + the (runGroovyForResult-allocated) result path and
 * returns the script text, no IDE contact. Composes the shared reflection chain
 * ({@link GROOVY_TAB_HELPERS}) so `viewOf`/`pidOf` match the rename path exactly.
 * `pids` are rendered as QUOTED string literals into a `Set` and compared with
 * `String.valueOf(pid)` (pid() is a Long — an injected int would never `.equals`
 * it), mirroring groovyRenameByPid / groovyFocusByPid.
 *
 * The marker ({@link GROOVY_RESULT_PENDING}) is written synchronously up front, the
 * work runs in `invokeLater` on the EDT, and the answer is written from `finally`.
 * Only a MATCHED tab overwrites the marker — with no match the file keeps the
 * marker, so the poll times out to null (fail-open). The payload is built with
 * `JsonOutput.toJson` so any character in the title (quotes, backslashes) is
 * escaped: `{"pid":<long>,"title":<string>}`.
 */
export const groovyReadTitleByPid = (pids: readonly number[], resultPath: string): string => {
    const pidSet = pids.map((pid) => `"${Math.trunc(pid)}"`).join(", ")
    const out = escapeGroovy(resultPath)
    return `import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.wm.ToolWindowManager
import groovy.json.JsonOutput

${GROOVY_TAB_HELPERS}

def OUT = "${out}"
def PIDS = [${pidSet}] as Set
try { new File(OUT).text = '${GROOVY_RESULT_PENDING}' } catch (Throwable t) {}

ApplicationManager.getApplication().invokeLater({
    def result = null
    try {
        for (project in ProjectManager.getInstance().getOpenProjects()) {
            try {
                def tw = ToolWindowManager.getInstance(project).getToolWindow("Terminal")
                if (tw == null) continue
                for (c in tw.getContentManager().getContents()) {
                    try {
                        def view = viewOf(c)
                        if (view == null) continue
                        def pid = pidOf(view)
                        if (pid == null || !PIDS.contains(String.valueOf(pid))) continue
                        result = JsonOutput.toJson([pid: String.valueOf(pid), title: String.valueOf(c.getDisplayName())])
                    } catch (Throwable t) {}
                }
            } catch (Throwable t) {}
        }
    } catch (Throwable t) {
    } finally {
        try { if (result != null) new File(OUT).text = result } catch (Throwable t) {}
    }
} as Runnable)
`
}

/**
 * Parse the title JSON the Groovy wrote — fail-open on anything unexpected.
 *
 * `null` (timeout/miss), non-JSON, or a JSON object whose `title` is absent or not
 * a string all resolve to null. An empty-string title also reads as null (nothing
 * usable). Never throws.
 */
export const parseTitle = (text: string | null): string | null => {
    if (text === null) {
        return null
    }
    try {
        const parsed = JSON.parse(text) as Record<string, unknown>
        const title = parsed.title
        return typeof title === "string" && title.length > 0 ? title : null
    } catch {
        return null
    }
}

/** Injectable seams for {@link readTabTitle}; production uses the real launcher scan + result round-trip. */
export type ReadTabTitleDeps = {
    /** Resolve every running JetBrains launcher (default: platform resolveExecPaths). */
    resolveExecPaths?: () => Promise<string[]>
    /** Narrow launchers to the launching product (default: platform filterExecsForLaunchingProduct). */
    filterExecsForLaunchingProduct?: (execPaths: Iterable<string>, bundleId?: string) => string[]
    /** Dispatch the builder and round-trip the result JSON (default: {@link runGroovyForResult}). */
    runGroovyForResult?: (
        buildGroovy: (resultPath: string) => string,
        note: string,
        execPaths: readonly string[],
        deps?: RunGroovyForResultDeps
    ) => Promise<string | null>
}

/**
 * Read the displayed title of the terminal tab whose backend pid is in `pids`.
 *
 * An EMPTY pid set (not in a terminal, or a failed probe) short-circuits to null —
 * it reads nothing rather than guessing. Otherwise it builds
 * {@link groovyReadTitleByPid}, dispatches it to the launcher filtered to the
 * product that launched us (like renameTab / isTabFocused — the ancestry `runGroovy`
 * throws under tmux, so the table-scan set is the only reliable path), round-trips
 * the JSON via {@link runGroovyForResult}, and parses it with {@link parseTitle}.
 *
 * NEVER throws: any failure (a rejecting seam, a dispatch error, a parse miss) is
 * caught and degrades to null. `deps` injects every IDE-contact seam for hermetic
 * tests.
 */
export const readTabTitle = async (pids: readonly number[], deps: ReadTabTitleDeps = {}): Promise<string | null> => {
    try {
        if (pids.length === 0) {
            return null
        }
        const resolveExecs = deps.resolveExecPaths ?? resolveExecPaths
        const filterExecs = deps.filterExecsForLaunchingProduct ?? filterExecsForLaunchingProduct
        const runForResult = deps.runGroovyForResult ?? runGroovyForResult
        const execPaths = filterExecs(await resolveExecs())
        const text = await runForResult(
            (resultPath) => groovyReadTitleByPid(pids, resultPath),
            "tab-read: could not read tab title",
            execPaths
        )
        return parseTitle(text)
    } catch {
        return null // fail-open: an unreadable title falls back to the project label upstream
    }
}
