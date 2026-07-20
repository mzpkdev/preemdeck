/**
 * tab-groovy.ts — the shared Groovy reflection chain for the reworked (Gen2)
 * JetBrains terminal.
 *
 * The single source of truth for "walk an open project's Terminal tool window
 * down to a Content's backend process pid". Both the rename path (core/tab.ts,
 * which also needs the `view` for the tab title) and the focus path
 * (core/tab-focus.ts, which needs the pid to match our tab) compose these SAME
 * closures rather than each carrying its own copy — so the proven chain drifts
 * in one place, never two.
 *
 * {@link GROOVY_TAB_HELPERS} is a preamble of `def`-bound Groovy closures,
 * emitted verbatim into a script AFTER its imports and BEFORE its body:
 *
 * - `inv(obj, name)` — call a no-arg method by name, null on any failure.
 * - `fieldDeep(obj, nm)` — read a (possibly inherited) declared field, null-safe.
 * - `allFields(obj)` — every declared field up the superclass chain.
 * - `enclosing(obj)` — the synthetic `this$0` outer instance of an inner class.
 * - `findDesc(comp, needle)` — the first descendant AWT component whose class
 *   name contains `needle`.
 * - `viewOf(content)` — the `TerminalViewImpl` for a terminal `Content`: the
 *   `TerminalViewImpl$TerminalPanel` descendant's enclosing instance (or null).
 *   The ONE place the panel-class literal lives.
 * - `huntProcess(root)` — bounded DFS for a `java.lang.Process` reachable through
 *   the terminal object graph (the fallback when the explicit field path misses).
 * - `pidOf(view)` — the proven view -> `sessionFuture` -> frontend session id ->
 *   `TerminalSessionsManager.getSession(id)` -> `delegate.ttyConnector.connector
 *   .myProcess` (or `huntProcess`) -> `.pid()` (a Long), null on any miss.
 *
 * {@link GROOVY_TAB_TARGET_HELPERS} adds the namespace-safe identity layer:
 * `termSessionIdOf(view)` reads the startup environment inherited by the
 * terminal, and `matchesTab(view, pids, sessions)` accepts either exact pid or
 * exact `TERM_SESSION_ID`. It depends on `inv` and `pidOf`, so scripts splice it
 * after {@link GROOVY_TAB_HELPERS}.
 *
 * The preamble carries NO imports; the composing script must import
 * `com.intellij.openapi.application.ApplicationManager` (used by `pidOf`) itself —
 * both callers already do, alongside the ProjectManager/ToolWindowManager they
 * need for the surrounding loop. The `$`-bearing literals (`this$0`,
 * `TerminalViewImpl$TerminalPanel`) are SINGLE-quoted so Groovy can't interpolate
 * them and the TS template can't mangle them.
 */

/**
 * The proven Gen2 reflection helper closures — the shared preamble both the
 * rename and focus scripts splice in verbatim after their imports.
 *
 * No leading or trailing newline, so a caller can wrap it as
 * `${imports}\n\n${GROOVY_TAB_HELPERS}\n${body}`. Callers reach a Content's pid
 * via `pidOf(viewOf(content))` and, when they also need the view (tab.ts, for the
 * title), keep the `viewOf(content)` result.
 */
export const GROOVY_TAB_HELPERS = `def inv = { obj, name -> try { return obj?.getClass()?.getMethod(name)?.invoke(obj) } catch (Throwable t) { return null } }
def fieldDeep = { obj, String nm -> if (obj == null) return null; def c = obj.getClass(); while (c != null && c != Object.class) { try { def f = c.getDeclaredField(nm); f.setAccessible(true); return f.get(obj) } catch (Throwable t) {}; c = c.getSuperclass() }; return null }
def allFields = { obj -> def res = []; def c = obj.getClass(); while (c != null && c != Object.class) { res.addAll(c.getDeclaredFields() as List); c = c.getSuperclass() }; return res }
def enclosing = { obj -> try { def f = obj.getClass().getDeclaredField('this$0'); f.setAccessible(true); return f.get(obj) } catch (Throwable t) { return null } }
def findDesc
findDesc = { comp, String needle -> if (comp == null) return null; if (comp.getClass().getName().contains(needle)) return comp; if (comp instanceof java.awt.Container) { for (kid in comp.getComponents()) { def r = findDesc(kid, needle); if (r != null) return r } }; return null }
def viewOf = { content -> enclosing(findDesc(content.getComponent(), 'TerminalViewImpl$TerminalPanel')) }
def huntProcess = { root ->
    def visited = new java.util.IdentityHashMap(); int[] n = [0]; def found = [null]
    def dfs
    dfs = { obj, int depth ->
        if (obj == null || found[0] != null || depth > 10 || n[0] > 12000 || visited.containsKey(obj)) return
        visited.put(obj, true); n[0]++
        if (obj instanceof java.lang.Process) { found[0] = obj; return }
        if (obj instanceof java.util.concurrent.CompletableFuture) { def r = null; try { r = obj.getNow(null) } catch (Throwable t) {}; dfs(r, depth + 1); return }
        def cn = obj.getClass().getName()
        if (!(cn.startsWith("com.intellij.terminal") || cn.startsWith("org.jetbrains.plugins.terminal") || cn.startsWith("com.jediterm") || cn.startsWith("com.pty4j"))) return
        for (f in allFields(obj)) { if (java.lang.reflect.Modifier.isStatic(f.getModifiers())) continue; try { f.setAccessible(true); dfs(f.get(obj), depth + 1) } catch (Throwable t) {} }
    }
    dfs(root, 0); return found[0]
}
def pidOf = { view ->
    try {
        def fsFut = fieldDeep(view, "sessionFuture")
        def fs = (fsFut instanceof java.util.concurrent.CompletableFuture) ? fsFut.getNow(null) : null
        def sid = inv(fs, "getId")
        if (sid == null) return null
        def mgrCls = Class.forName("com.intellij.terminal.backend.TerminalSessionsManager")
        def mgr = ApplicationManager.getApplication().getService(mgrCls)
        def idCls = Class.forName("org.jetbrains.plugins.terminal.block.reworked.session.rpc.TerminalSessionId")
        def backend = mgrCls.getMethod("getSession", idCls).invoke(mgr, sid)
        if (backend == null) return null
        def cur = backend; ["delegate", "ttyConnector", "connector", "myProcess"].each { nm -> cur = fieldDeep(cur, nm) }
        def proc = (cur instanceof java.lang.Process) ? cur : huntProcess(backend)
        return proc?.pid()
    } catch (Throwable t) { return null }
}`

/**
 * Shared tab-identity helpers for every rename, read, and focus script.
 * The pid branch accepts the current string representation and a native Long,
 * preserving existing builders while keeping the matcher reusable.
 */
export const GROOVY_TAB_TARGET_HELPERS = `def termSessionIdOf = { view ->
    def deferred = inv(view, 'getStartupOptionsDeferred')
    def options = inv(deferred, 'getCompleted')
    def variables = inv(options, 'getEnvVariables')
    return variables?.get('TERM_SESSION_ID')
}
def matchesTab = { view, pids, sessions ->
    def pid = pidOf(view)
    def session = termSessionIdOf(view)
    return (pid != null && (pids.contains(pid) || pids.contains(String.valueOf(pid)))) ||
        (session != null && sessions.contains(String.valueOf(session)))
}`
