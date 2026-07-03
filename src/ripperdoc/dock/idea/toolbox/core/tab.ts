/**
 * tab.ts — rename the WebStorm terminal tab a shell runs in, by process id.
 *
 * The IDE-side half of `rename-tab` (the shell-side pid resolver is
 * tab-pids.ts). Given the pid set living on our tab's tty, generate a one-shot
 * Groovy that walks EVERY open project's Terminal tool window, computes each
 * tab's backend process pid, and renames only the tab(s) whose pid is in the
 * set. Pids are globally unique, so the match is exact — no cwd/window
 * targeting is needed, and no other project's tab is ever touched.
 *
 * The reflection chain is the proven Gen2 (reworked) terminal path for WebStorm
 * 2025.3.2:
 *
 * - view: the descendant component whose class name contains
 *   `TerminalViewImpl$TerminalPanel`, then its synthetic `this$0` enclosing
 *   instance (`com.intellij.terminal.frontend.view.impl.TerminalViewImpl`).
 * - pid: view.sessionFuture (a CompletableFuture) -> frontend session id ->
 *   `TerminalSessionsManager.getSession(id)` -> walk `delegate.ttyConnector
 *   .connector.myProcess` to a `java.lang.Process`, falling back to a bounded
 *   DFS (`huntProcess`) for any Process reachable through the terminal object
 *   graph -> `.pid()` (a Long).
 * - rename: `view.getTitle().change { st -> st.setUserDefinedTitle(NAME) }` — a
 *   USER-DEFINED title, which wins over OSC/shell auto-naming and sticks; a null
 *   NAME clears it (restores auto-naming). NOT `content.setDisplayName`, which
 *   the title listener clobbers.
 *
 * Every step is wrapped in try/catch -> null, so a tab that doesn't resolve is
 * skipped, never mismatched. The reflection helper closures (`inv`, `fieldDeep`,
 * `allFields`, `enclosing`, `findDesc`, `viewOf`, `huntProcess`, `pidOf`) are the
 * proven chain, shared verbatim from tab-groovy.ts (GROOVY_TAB_HELPERS); only
 * `doChange` / `setStr` (the title mutation) are rename-specific and kept here.
 *
 * Dispatch: `runGroovyOn` against the running launchers filtered to the product
 * that launched us (WebStorm here) — the normal ancestry `runGroovy` throws
 * from inside tmux, so it can't be used. Never throws (runGroovyOn swallows a
 * missing IDE / spawn error).
 */

import { type RunGroovyDeps, runGroovyOn } from "./groovy"
// Imported from the platform barrel (like launch.ts) so the product filter and
// launcher scan resolve to the current OS. Used only at call time inside
// renameTab, so the index<->tab import cycle is harmless (mirrors launch.ts).
import { filterExecsForLaunchingProduct, resolveExecPaths } from "./index"
import { GROOVY_TAB_HELPERS } from "./tab-groovy"

/**
 * Wrap `value` as a SINGLE-quoted Groovy string literal, escaping `\` and `'`.
 *
 * Single-quoted (not double) on purpose: Groovy interpolates `$`/`${…}` inside
 * double-quoted GStrings, so a tab name like `a$b` or `x${y}` would be
 * mis-rendered or fail to compile. A single-quoted literal treats `$` as an
 * ordinary character, so only `\` and `'` need escaping.
 */
const groovyStringLiteral = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`

/**
 * Build the one-shot Groovy that renames every open terminal tab whose backend
 * process pid is in `pids` to `name` — or clears the user-defined title
 * (restoring auto-naming) when `name` is `null`.
 *
 * Pure: takes the pid set + name and returns the script text, no IDE contact.
 * `pids` are rendered as QUOTED string literals into a `Set` and compared with
 * `String.valueOf(pid)` — `pid()` returns a Long, and an injected Groovy int
 * would never `.equals` it, so the comparison is done as strings. `name` is
 * embedded through {@link groovyStringLiteral} as a SINGLE-quoted literal (or
 * the bare token `null` for a reset).
 *
 * Every embedded literal is SINGLE-quoted Groovy — the name, and the reflection
 * literals (`this$0`, `TerminalViewImpl$TerminalPanel`) — so a `$` in any of
 * them can't trigger GString interpolation (which would mis-render the name or
 * fail to compile), and the TS template never mangles them either.
 */
export const groovyRenameByPid = (pids: readonly number[], name: string | null): string => {
    const pidSet = pids.map((pid) => `"${Math.trunc(pid)}"`).join(", ")
    const nameLiteral = name === null ? "null" : groovyStringLiteral(name)
    return `import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.wm.ToolWindowManager

${GROOVY_TAB_HELPERS}
def doChange = { title, Closure body ->
    def fn = ({ st -> body(st); return kotlin.Unit.INSTANCE } as kotlin.jvm.functions.Function1)
    title.getClass().getMethod("change", kotlin.jvm.functions.Function1).invoke(title, fn)
}
def setStr = { st, String setter, Object val -> st.getClass().getMethod(setter, String).invoke(st, [val] as Object[]) }

def PIDS = [${pidSet}] as Set
def NAME = ${nameLiteral}

ApplicationManager.getApplication().invokeLater({
    try {
        ProjectManager.getInstance().getOpenProjects().each { project ->
            try {
                def tw = ToolWindowManager.getInstance(project).getToolWindow("Terminal")
                if (tw == null) return
                tw.getContentManager().getContents().each { c ->
                    try {
                        def view = viewOf(c)
                        if (view == null) return
                        def pid = pidOf(view)
                        if (pid == null || !PIDS.contains(String.valueOf(pid))) return
                        def title = inv(view, "getTitle")
                        if (title == null) return
                        doChange(title) { st -> setStr(st, "setUserDefinedTitle", NAME) }
                    } catch (Throwable t) {}
                }
            } catch (Throwable t) {}
        }
    } catch (Throwable t) {}
} as Runnable)
`
}

/** Seams for {@link renameTab}: the runGroovyOn deps, plus the launcher-scan seam. */
export type RenameTabDeps = RunGroovyDeps & {
    /** Resolve every running JetBrains launcher (default: platform `resolveExecPaths`). */
    resolveExecPaths?: () => Promise<string[]>
}

/**
 * Rename the terminal tab(s) whose backend process pid is in `pids` to `name`
 * (or clear the user-defined title, restoring auto-naming, when `name` is
 * `null`). Best-effort: NEVER throws, and an empty `pids` is a no-op — it
 * renames nothing rather than guessing.
 *
 * Dispatch goes through {@link runGroovyOn} against the running launchers
 * filtered to the product that launched us: the ancestry-based `runGroovy`
 * throws from inside tmux (its process walk can't cross the tmux server), so the
 * table-scan launcher set is the only reliable path here. The filter keeps just
 * the launching product (falling back to every running launcher when it can't
 * be identified), so the script only reaches the IDE that owns our tab.
 *
 * This does NOT wrap the dispatch in cmdore `effect()` — the CLI (rename-tab.ts)
 * owns the `--dry-run` gate, keeping core free of the CLI framework.
 *
 * `deps` forwards the runGroovyOn seams (launch / reapLater / writeTemp / warn)
 * and an optional launcher-scan seam for hermetic tests.
 */
export const renameTab = async (
    name: string | null,
    pids: readonly number[],
    deps: RenameTabDeps = {}
): Promise<void> => {
    if (pids.length === 0) {
        return
    }
    const { resolveExecPaths: resolveExecPathsDep, ...runDeps } = deps
    const resolve = resolveExecPathsDep ?? resolveExecPaths
    const groovy = groovyRenameByPid(pids, name)
    const execPaths = filterExecsForLaunchingProduct(await resolve())
    await runGroovyOn(groovy, "rename-tab: could not rename tab", execPaths, runDeps)
}
