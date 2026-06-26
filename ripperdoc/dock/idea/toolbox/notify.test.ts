/**
 * notify.test.ts — hermetic unit tests for the rendered notification Groovy.
 *
 * groovyFor() is pure string-gen, so we assert the load-bearing structure
 * directly (no IDE, no ideScript): the per-target `fire` closure, the cwd
 * window-targeting in the default path, the all-windows broadcast, and that the
 * cwd literal is escaped like every other embedded string (the injection guard).
 */

import { describe, expect, it } from "bun:test"
import { groovyFor } from "./notify.ts"

describe("groovyFor", () => {
    it("builds a fresh Notification per target via the fire closure", () => {
        const g = groovyFor("Title", "Body", "info", [], "/Users/me/proj", false)
        expect(g).toContain("def fire = { target ->")
        expect(g).toContain('new Notification("idea.toolbox", "Title", "Body", NotificationType.INFORMATION)')
        expect(g).toContain("Notifications.Bus.notify(n, target)")
    })

    it("maps the type token to its NotificationType constant", () => {
        expect(groovyFor("T", "M", "warning", [], "/p", false)).toContain("NotificationType.WARNING")
        expect(groovyFor("T", "M", "error", [], "/p", false)).toContain("NotificationType.ERROR")
    })

    describe("default (terminal window) targeting", () => {
        const g = groovyFor("T", "M", "info", [], "/Users/me/proj", false)

        it("does not take the broadcast branch", () => {
            expect(g).toContain("if (false)")
        })

        it("picks the project whose basePath is the longest prefix of cwd", () => {
            expect(g).toContain('def cwd = "/Users/me/proj"')
            expect(g).toContain('cwd == bp || cwd.startsWith(bp + "/")')
            expect(g).toContain("bp.length() > bestLen")
            expect(g).toContain("fire(best)")
        })
    })

    describe("--all (broadcast) targeting", () => {
        const g = groovyFor("T", "M", "info", [], "/Users/me/proj", true)

        it("fires into every open project", () => {
            expect(g).toContain("if (true)")
            expect(g).toContain("projects.each { fire(it) }")
        })

        it("falls back to an application-level pop when no project is open", () => {
            expect(g).toContain("if (projects.length == 0) fire(null)")
        })
    })

    it("escapes the cwd literal so a crafted path cannot break out of the string", () => {
        const g = groovyFor("T", "M", "info", [], '/a"b\\c', false)
        expect(g).toContain('def cwd = "/a\\"b\\\\c"')
        // the raw, unescaped path must never appear in the script
        expect(g).not.toContain('/a"b\\c')
    })

    it("renders clickable actions inside the per-target closure", () => {
        const g = groovyFor("T", "M", "error", [{ name: "open-url", arg: "https://x" }], "/p", false)
        expect(g).toContain("n.addAction(")
        expect(g).toContain('com.intellij.ide.BrowserUtil.browse("https://x")')
    })
})
