/**
 * notify.test.ts — hermetic unit tests for the rendered notification Groovy.
 *
 * groovyFor() is pure string-gen, so we assert the load-bearing structure
 * directly (no IDE, no ideScript): the per-target `fire` closure, the cwd
 * window-targeting (and its null/application-level fallback), and that the cwd
 * literal is escaped like every other embedded string (the injection guard). The
 * `--all` broadcast is NOT in this Groovy — it lives at dispatch (one run of this
 * same single-window script per running IDE) and is covered by runGroovyOn +
 * resolveExecPaths.
 */

import { describe, expect, it } from "bun:test"
import { groovyFor } from "./notify.ts"

describe("groovyFor", () => {
    it("builds a fresh Notification per target via the fire closure", () => {
        const g = groovyFor("Title", "Body", "info", [], "/Users/me/proj")
        expect(g).toContain("def fire = { target ->")
        expect(g).toContain('new Notification("idea.toolbox", "Title", "Body", NotificationType.INFORMATION)')
        expect(g).toContain("Notifications.Bus.notify(n, target)")
    })

    it("maps the type token to its NotificationType constant", () => {
        expect(groovyFor("T", "M", "warning", [], "/p")).toContain("NotificationType.WARNING")
        expect(groovyFor("T", "M", "error", [], "/p")).toContain("NotificationType.ERROR")
    })

    describe("single-window (terminal) targeting", () => {
        const g = groovyFor("T", "M", "info", [], "/Users/me/proj")

        it("has no all-windows broadcast branch (broadcast is at dispatch)", () => {
            expect(g).not.toContain("projects.each { fire(it) }")
            expect(g).not.toContain("if (projects.length == 0) fire(null)")
        })

        it("picks the project whose basePath is the longest prefix of cwd", () => {
            expect(g).toContain('def cwd = "/Users/me/proj"')
            expect(g).toContain('cwd == bp || cwd.startsWith(bp + "/")')
            expect(g).toContain("bp.length() > bestLen")
            expect(g).toContain("fire(best)")
        })

        it("falls back to a null/application-level target when cwd matches no project", () => {
            // `best` starts null and survives when no open project's basePath prefixes
            // cwd — IntelliJ routes a null target to the focused frame. In a non-launching
            // IDE (cwd outside all its projects) this is the path that fires.
            expect(g).toContain("def best = null")
        })
    })

    it("escapes the cwd literal so a crafted path cannot break out of the string", () => {
        const g = groovyFor("T", "M", "info", [], '/a"b\\c')
        expect(g).toContain('def cwd = "/a\\"b\\\\c"')
        // the raw, unescaped path must never appear in the script
        expect(g).not.toContain('/a"b\\c')
    })

    it("renders clickable actions inside the per-target closure", () => {
        const g = groovyFor("T", "M", "error", [{ name: "open-url", arg: "https://x" }], "/p")
        expect(g).toContain("n.addAction(")
        expect(g).toContain('com.intellij.ide.BrowserUtil.browse("https://x")')
    })
})
