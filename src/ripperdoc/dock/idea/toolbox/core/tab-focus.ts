/**
 * tab-focus.ts — "is the terminal TAB this shell runs in currently focused in the
 * IDE?", read back from the live JetBrains IDE by process id.
 *
 * The read counterpart of core/tab.ts's rename: instead of MUTATING the pid-matched
 * terminal Content, it READS three focus signals off it and folds them into a
 * single verdict. Built for reuse — e.g. gating a notification on whether the user
 * is actually looking at this terminal.
 *
 * The tab is found exactly as rename-tab finds it: {@link resolveTabPids} lists the
 * pids on this shell's tty (login shell + any tmux client), and the Groovy matches
 * the one terminal Content whose backend process pid is one of them (pids are
 * globally unique). The heavy reflection — walk each open project's Terminal tool
 * window, resolve each Content's view and backend pid — is the SHARED chain from
 * core/tab-groovy.ts ({@link GROOVY_TAB_HELPERS}: `viewOf` + `pidOf`), so it never
 * drifts from the rename path.
 *
 * Three signals are read for the matched tab, on the EDT:
 * - `tabSelected`      — is our Content the tool window's SELECTED content?
 *                        (`contentManager.getSelectedContent() == our content`)
 * - `toolWindowActive` — is the Terminal tool window itself active? (`toolWindow.isActive()`)
 * - `frameFocused`     — does the project's IDE frame have OS focus?
 *                        (`WindowManager.getInstance().getFrame(project).isFocused()`)
 *
 * The verdict is the CONJUNCTION: `focused = tabSelected && toolWindowActive &&
 * frameFocused` — the tab is truly the thing the user is looking at only when our
 * Content is selected, in an active terminal tool window, in a focused frame. The
 * three parts are returned alongside the verdict so a caller can pick a DIFFERENT
 * threshold (e.g. ignore `frameFocused` to mean "selected in this IDE regardless of
 * OS focus", or require only `tabSelected`).
 *
 * FAIL-OPEN, NEVER THROWS. No pid on this tty, no live IDE, no matching tab, a
 * dispatch/timeout/parse miss — every undetermined case resolves to
 * {@link UNDETERMINED} (`focused: false`, all parts false). "Undetermined" is
 * treated as "not focused" on purpose: a notify caller gating on `!focused` should
 * still fire when we simply couldn't tell.
 */

import { escapeGroovy, GROOVY_RESULT_PENDING, type RunGroovyForResultDeps, runGroovyForResult } from "./groovy"
import { filterExecsForLaunchingProduct, resolveExecPath, resolveExecPaths } from "./index"
import { GROOVY_TAB_HELPERS, GROOVY_TAB_TARGET_HELPERS } from "./tab-groovy"
import { normalizeTabTargets, resolveTabPids, resolveTabTargets, type TabTargets } from "./tab-pids"

/**
 * The focus reading for this tab: the conjunction verdict plus the three raw
 * signals it is built from, so a caller can re-threshold on the parts.
 */
export type TabFocus = {
    /** `tabSelected && toolWindowActive && frameFocused` — the strict "user is looking here" verdict. */
    focused: boolean
    /** Our Content is the terminal tool window's selected tab. */
    tabSelected: boolean
    /** The Terminal tool window is active. */
    toolWindowActive: boolean
    /** The project's IDE frame has OS window focus. */
    frameFocused: boolean
}

/**
 * The fail-open reading: everything false. Returned for every undetermined case
 * (no pid, no IDE, no match, timeout, parse error) so an undetermined read counts
 * as NOT focused and a `!focused` notify gate still fires.
 */
export const UNDETERMINED: TabFocus = {
    focused: false,
    tabSelected: false,
    toolWindowActive: false,
    frameFocused: false
}

/**
 * Build the one-shot Groovy that finds the terminal Content whose backend pid is in
 * `pids` and writes its focus JSON to `resultPath`.
 *
 * Pure — takes the pid set + the (runGroovyForResult-allocated) result path and
 * returns the script text, no IDE contact. Composes the shared reflection chain
 * ({@link GROOVY_TAB_HELPERS}) so `viewOf`/`pidOf` match the rename path exactly.
 * `pids` are rendered as QUOTED string literals into a `Set` and compared with
 * `String.valueOf(pid)` (pid() is a Long — an injected int would never `.equals`
 * it), mirroring groovyRenameByPid.
 *
 * A marker ({@link GROOVY_RESULT_PENDING}) is written SYNCHRONOUSLY up front (so a
 * silently-swallowed compile error is distinguishable from a slow launch), the real
 * work runs in `invokeLater` on the EDT, and the answer is written from a `finally`.
 * Only a MATCHED tab overwrites the marker with JSON; with no match the file keeps
 * the marker, so the poll times out to null (fail-open) rather than reporting a
 * stale/foreign tab. The JSON is `{"pid":<long>,"tabSelected":<bool>,
 * "toolWindowActive":<bool>,"frameFocused":<bool>}`.
 */
const groovySingleQuoted = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`

export const groovyFocusByTargets = (targets: TabTargets, resultPath: string): string => {
    const pidSet = targets.pids.map((pid) => `"${Math.trunc(pid)}"`).join(", ")
    const sessionSet = targets.termSessionIds.map(groovySingleQuoted).join(", ")
    const out = escapeGroovy(resultPath)
    return `import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.openapi.wm.WindowManager

${GROOVY_TAB_HELPERS}
${GROOVY_TAB_TARGET_HELPERS}

def OUT = "${out}"
def PIDS = [${pidSet}] as Set
def SESSION_IDS = [${sessionSet}] as Set
try { new File(OUT).text = '${GROOVY_RESULT_PENDING}' } catch (Throwable t) {}

ApplicationManager.getApplication().invokeLater({
    def result = null
    try {
        for (project in ProjectManager.getInstance().getOpenProjects()) {
            try {
                def tw = ToolWindowManager.getInstance(project).getToolWindow("Terminal")
                if (tw == null) continue
                def selected = tw.getContentManager().getSelectedContent()
                def frame = WindowManager.getInstance().getFrame(project)
                for (c in tw.getContentManager().getContents()) {
                    try {
                        def view = viewOf(c)
                        if (view == null) continue
                        def pid = pidOf(view)
                        if (!matchesTab(view, PIDS, SESSION_IDS)) continue
                        def tabSelected = (c == selected)
                        def toolWindowActive = tw.isActive()
                        def frameFocused = (frame == null) ? false : frame.isFocused()
                        result = '{"pid":' + String.valueOf(pid) + ',"tabSelected":' + tabSelected + ',"toolWindowActive":' + toolWindowActive + ',"frameFocused":' + frameFocused + '}'
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

/** Legacy PID-only builder retained for existing imports. */
export const groovyFocusByPid = (pids: readonly number[], resultPath: string): string =>
    groovyFocusByTargets({ pids: [...pids], termSessionIds: [] }, resultPath)

/**
 * Parse the focus JSON the Groovy wrote — fail-open on anything unexpected.
 *
 * `null` (timeout/miss), non-JSON, or a JSON object missing/mistyping the signals
 * all resolve to {@link UNDETERMINED}. Each signal is read STRICTLY (`=== true`),
 * so any non-boolean-true value reads as false, and the verdict is the conjunction
 * `tabSelected && toolWindowActive && frameFocused`. Never throws.
 */
export const parseFocus = (text: string | null): TabFocus => {
    if (text === null) {
        return UNDETERMINED
    }
    try {
        const parsed = JSON.parse(text) as Record<string, unknown>
        const tabSelected = parsed.tabSelected === true
        const toolWindowActive = parsed.toolWindowActive === true
        const frameFocused = parsed.frameFocused === true
        return {
            focused: tabSelected && toolWindowActive && frameFocused,
            tabSelected,
            toolWindowActive,
            frameFocused
        }
    } catch {
        return UNDETERMINED
    }
}

/** Injectable seams for {@link isTabFocused}; production uses the real pid resolver, launcher scan, and result round-trip. */
export type IsTabFocusedDeps = {
    /** Resolve the shared tab identity when no explicit input is supplied. */
    resolveTabTargets?: () => Promise<TabTargets>
    /** Resolve the pid set on this tab's tty (default: core resolveTabPids). */
    resolveTabPids?: () => Promise<number[]>
    /** Resolve the owning launcher directly on Linux. */
    resolveExecPath?: () => Promise<string>
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
 * Read whether the terminal tab this shell runs in is currently focused in the IDE.
 *
 * Resolves `pids` via {@link resolveTabPids} when omitted; an EMPTY pid set (not in
 * a terminal, or a failed probe) short-circuits to {@link UNDETERMINED} — it reads
 * nothing rather than guessing. Otherwise it builds {@link groovyFocusByPid},
 * dispatches it to the launcher filtered to the product that launched us (like
 * renameTab — the ancestry `runGroovy` throws under tmux, so the table-scan set is
 * the only reliable path), round-trips the JSON via {@link runGroovyForResult}, and
 * parses it with {@link parseFocus}.
 *
 * NEVER throws: any failure (a rejecting seam, a dispatch error, a parse miss)
 * is caught and degrades to {@link UNDETERMINED}. `deps` injects every IDE-contact
 * seam for hermetic tests.
 */
export function isTabFocused(pids?: readonly number[], deps?: IsTabFocusedDeps): Promise<TabFocus>
export function isTabFocused(targets?: TabTargets, deps?: IsTabFocusedDeps): Promise<TabFocus>
export async function isTabFocused(
    input?: readonly number[] | TabTargets,
    deps: IsTabFocusedDeps = {}
): Promise<TabFocus> {
    try {
        const runForResult = deps.runGroovyForResult ?? runGroovyForResult

        const targets = input
            ? normalizeTabTargets(input)
            : deps.resolveTabTargets
              ? await deps.resolveTabTargets()
              : deps.resolveTabPids
                ? normalizeTabTargets(await (deps.resolveTabPids ?? resolveTabPids)())
                : await resolveTabTargets()
        if (targets.pids.length === 0 && targets.termSessionIds.length === 0) {
            return UNDETERMINED
        }
        const owner =
            process.platform === "linux" || deps.resolveExecPath
                ? await (deps.resolveExecPath ?? resolveExecPath)().catch(() => null)
                : null
        const execPaths = owner
            ? [owner]
            : (deps.filterExecsForLaunchingProduct ?? filterExecsForLaunchingProduct)(
                  await (deps.resolveExecPaths ?? resolveExecPaths)()
              )
        const text = await runForResult(
            (resultPath) => groovyFocusByTargets(targets, resultPath),
            "tab-focused: could not read focus state",
            execPaths
        )
        return parseFocus(text)
    } catch {
        // Fail-open: an undetermined read counts as NOT focused so a notify gate still fires.
        return UNDETERMINED
    }
}
