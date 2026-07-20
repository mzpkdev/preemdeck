/**
 * tab-groovy.spec.ts — the shared Gen2 reflection preamble, asserted once.
 *
 * GROOVY_TAB_HELPERS is a pure string constant spliced verbatim into BOTH the
 * rename (tab.ts) and focus (tab-focus.ts) scripts, so the load-bearing structure
 * is pinned here in ONE place rather than re-asserted in each composer: every
 * closure is defined, `viewOf` carries the terminal-panel class needle, `pidOf`
 * walks the proven session -> backend -> process chain, and the `$`-bearing
 * reflection literals stay SINGLE-quoted (so Groovy can't interpolate them). It
 * also composes cleanly — no leading/trailing newline — so a caller can wrap it as
 * `${imports}\n\n${GROOVY_TAB_HELPERS}\n${body}`.
 */

import { describe, expect, it } from "bun:test"
import { GROOVY_TAB_HELPERS, GROOVY_TAB_TARGET_HELPERS } from "./tab-groovy"

const context = describe

describe("GROOVY_TAB_HELPERS", () => {
    context("defines every shared closure", () => {
        it.each([
            "def inv = {",
            "def fieldDeep = {",
            "def allFields = {",
            "def enclosing = {",
            "findDesc = {",
            "def viewOf = {",
            "def huntProcess = {",
            "def pidOf = {"
        ])("binds %s", (needle) => {
            expect(GROOVY_TAB_HELPERS).toContain(needle)
        })
    })

    context("viewOf resolves a Content to its TerminalViewImpl", () => {
        it("finds the panel via the single-quoted 'TerminalViewImpl$TerminalPanel' needle on the content's component", () => {
            expect(GROOVY_TAB_HELPERS).toContain(
                "def viewOf = { content -> enclosing(findDesc(content.getComponent(), 'TerminalViewImpl$TerminalPanel')) }"
            )
        })
    })

    context("inv reaches public methods on package-private implementations", () => {
        it("makes the reflected method accessible before invoking it", () => {
            const accessible = GROOVY_TAB_HELPERS.indexOf("method.setAccessible(true)")
            const invoked = GROOVY_TAB_HELPERS.indexOf("return method.invoke(obj)")

            expect(accessible).toBeGreaterThan(-1)
            expect(invoked).toBeGreaterThan(accessible)
        })
    })

    context("pidOf walks the proven session -> backend -> process chain", () => {
        it.each([
            'fieldDeep(view, "sessionFuture")',
            'Class.forName("com.intellij.terminal.backend.TerminalSessionsManager")',
            'Class.forName("org.jetbrains.plugins.terminal.block.reworked.session.rpc.TerminalSessionId")',
            'mgrCls.getMethod("getSession", idCls)',
            '["delegate", "ttyConnector", "connector", "myProcess"]',
            "huntProcess(backend)",
            "return proc?.pid()"
        ])("includes %s", (needle) => {
            expect(GROOVY_TAB_HELPERS).toContain(needle)
        })
    })

    context("the `$`-bearing reflection literals stay single-quoted", () => {
        it("reaches the synthetic enclosing instance via 'this$0'", () => {
            expect(GROOVY_TAB_HELPERS).toContain("getDeclaredField('this$0')")
        })
    })

    context("composes cleanly (no leading/trailing newline)", () => {
        it("starts at the first closure and ends at a closing brace", () => {
            expect(GROOVY_TAB_HELPERS.startsWith("def inv = {")).toBe(true)
            expect(GROOVY_TAB_HELPERS.endsWith("}")).toBe(true)
            expect(GROOVY_TAB_HELPERS.startsWith("\n")).toBe(false)
            expect(GROOVY_TAB_HELPERS.endsWith("\n")).toBe(false)
        })
    })
})

describe("GROOVY_TAB_TARGET_HELPERS", () => {
    it("reads TERM_SESSION_ID from the terminal startup environment", () => {
        expect(GROOVY_TAB_TARGET_HELPERS).toContain("getStartupOptionsDeferred")
        expect(GROOVY_TAB_TARGET_HELPERS).toContain("getCompleted")
        expect(GROOVY_TAB_TARGET_HELPERS).toContain("getEnvVariables")
        expect(GROOVY_TAB_TARGET_HELPERS).toContain("variables?.get('TERM_SESSION_ID')")
    })

    it("matches either exact pid representation or startup session id", () => {
        expect(GROOVY_TAB_TARGET_HELPERS).toContain("pids.contains(pid)")
        expect(GROOVY_TAB_TARGET_HELPERS).toContain("pids.contains(String.valueOf(pid))")
        expect(GROOVY_TAB_TARGET_HELPERS).toContain("sessions.contains(String.valueOf(session))")
    })

    it("does not contain a catch-all match", () => {
        expect(GROOVY_TAB_TARGET_HELPERS).toContain("pid != null")
        expect(GROOVY_TAB_TARGET_HELPERS).toContain("session != null")
        expect(GROOVY_TAB_TARGET_HELPERS).not.toContain("return true")
    })

    it("composes cleanly after the reflection helpers", () => {
        expect(GROOVY_TAB_TARGET_HELPERS.startsWith("def termSessionIdOf = {")).toBe(true)
        expect(GROOVY_TAB_TARGET_HELPERS.endsWith("}")).toBe(true)
        expect(`${GROOVY_TAB_HELPERS}\n${GROOVY_TAB_TARGET_HELPERS}`).toContain("def matchesTab = {")
    })
})
