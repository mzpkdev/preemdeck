/**
 * notify.test.ts — hermetic suite. The one WRITE (runGroovy, the IDE Groovy
 * bridge) is mocked via cmdore's `effect.mock` keyed by the wrapper reference;
 * nothing spawns. The `inIdea` gate is forced through the PREEMDECK_FORCE_IN_IDEA
 * env override. Two layers:
 *   - the CLI (main): defaults, --type/--action validation, the inIdea gate, and
 *     exit codes, asserted through the captured Groovy (the mocked runGroovy).
 *   - the notify worker (Groovy render): the captured script carries the escaped
 *     title/message as literals, each --type maps to its constant, and the action
 *     closures match previewUrl's shared fragment.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { effect } from "cmdore"
import { escapeGroovy, webpreviewOpenBody } from "./core/index.ts"
import { main, notify, runGroovy } from "./notify.ts"

let scripts: string[]
let notes: string[]

/** Mock the `runGroovy` wrapper by reference: capture the generated Groovy + note, run nothing. */
const mockRunGroovy = (): void => {
    effect.mock(runGroovy, async (groovy: string, note: string) => {
        scripts.push(groovy)
        notes.push(note)
    })
}

beforeEach(() => {
    scripts = []
    notes = []
    process.env.PREEMDECK_FORCE_IN_IDEA = "1"
    effect.reset()
    mockRunGroovy()
})
afterEach(() => {
    delete process.env.PREEMDECK_FORCE_IN_IDEA
    effect.reset()
})

describe("main (CLI)", () => {
    test("message only -> defaults, exit 0", async () => {
        expect(await main(["build finished"])).toBe(0)
        const g = scripts[0] as string
        expect(g).toContain('"build finished"')
        expect(g).toContain('"PreemDeck"')
        expect(g).toContain("NotificationType.INFORMATION")
        expect(g).not.toContain("addAction")
    })

    test("threads title and type", async () => {
        expect(await main(["tests failed", "--title", "CI", "--type", "error"])).toBe(0)
        const g = scripts[0] as string
        expect(g).toContain('"tests failed"')
        expect(g).toContain('"CI"')
        expect(g).toContain("NotificationType.ERROR")
    })

    test.each([
        ["info", "INFORMATION"],
        ["warning", "WARNING"],
        ["error", "ERROR"]
    ])("accepts --type %s -> NotificationType.%s", async (kind, constant) => {
        expect(await main(["msg", "--type", kind])).toBe(0)
        expect(scripts[0]).toContain(`NotificationType.${constant}`)
    })

    test("unknown --type -> exit 2, worker untouched", async () => {
        const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
        try {
            expect(await main(["msg", "--type", "fatal"])).toBe(2)
            expect(scripts).toEqual([])
            const err = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")
            expect(err).toContain("notify:")
            expect(err).toContain("--type: invalid choice: 'fatal'")
        } finally {
            errSpy.mockRestore()
        }
    })

    test("missing message -> exit 2", async () => {
        const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
        try {
            expect(await main([])).toBe(2)
            expect(scripts).toEqual([])
            expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("notify:")
        } finally {
            errSpy.mockRestore()
        }
    })

    test("threads a single action", async () => {
        expect(await main(["msg", "--action", "open-url=https://example.com"])).toBe(0)
        const g = scripts[0] as string
        expect(g).toContain('NotificationAction.createSimple("Open in browser"')
        expect(g).toContain('com.intellij.ide.BrowserUtil.browse("https://example.com")')
    })

    test("multiple actions preserve CLI order", async () => {
        await main(["msg", "--action", "open-preview=https://x", "--action", "open-file=/tmp"])
        const g = scripts[0] as string
        expect((g.match(/addAction/g) ?? []).length).toBe(2)
        expect(g.indexOf('createSimple("Open preview"')).toBeLessThan(g.indexOf('createSimple("Open file"'))
    })

    test("action arg splits on the FIRST = only", async () => {
        await main(["msg", "--action", "open-url=https://example.com/search?a=1&b=2"])
        expect(scripts[0]).toContain('browse("https://example.com/search?a=1&b=2")')
    })

    test("unknown action -> exit 2, worker untouched", async () => {
        const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
        try {
            expect(await main(["msg", "--action", "open-everything=x"])).toBe(2)
            expect(scripts).toEqual([])
            const err = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")
            expect(err).toContain("--action: unknown action 'open-everything'")
        } finally {
            errSpy.mockRestore()
        }
    })

    test("action missing required arg -> exit 2", async () => {
        const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
        try {
            expect(await main(["msg", "--action", "open-url"])).toBe(2)
            expect(scripts).toEqual([])
            const err = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")
            expect(err).toContain("--action: action 'open-url' needs an argument")
        } finally {
            errSpy.mockRestore()
        }
    })

    test("outside JetBrains -> 1 before work, even with actions", async () => {
        // Force the real gate shut; run() throws IdeaError before any runGroovy.
        process.env.PREEMDECK_FORCE_IN_IDEA = "0"
        const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
        try {
            expect(await main(["msg", "--action", "open-url=https://example.com"])).toBe(1)
            expect(scripts).toEqual([])
            expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain(
                "notify: no JetBrains IDE in the process ancestry"
            )
        } finally {
            errSpy.mockRestore()
        }
    })

    test("--dry-run records the runGroovy but skips the real write", async () => {
        // No mock for runGroovy: on dry-run cmdore flips effect.enabled off, so the
        // unmocked wrapper records the call and returns undefined without spawning.
        effect.reset()
        expect(await main(["msg", "--dry-run"])).toBe(0)
        // Recorded the intended call...
        expect(effect.log.some((entry) => entry.wrapper === runGroovy)).toBe(true)
        // ...but the recorder stub never ran (the real runGroovy was skipped).
        expect(scripts.length).toBe(0)
    })
})

describe("notify worker (Groovy render)", () => {
    test("injects message, title, group, and Bus.notify", async () => {
        await notify("build finished", { title: "CI" })
        const g = scripts[0] as string
        expect(g).toContain("new Notification(")
        expect(g).toContain("Notifications.Bus.notify(n, project)")
        expect(g).toContain("getOpenProjects()")
        expect(g).toContain('"CI"')
        expect(g).toContain('"build finished"')
        expect(g).toContain('"idea.toolbox"')
    })

    test("default title is PreemDeck", async () => {
        await notify("hello")
        expect(scripts[0]).toContain('"PreemDeck"')
    })

    test.each([
        ["info", "INFORMATION"],
        ["warning", "WARNING"],
        ["error", "ERROR"]
    ])("--type %s maps to NotificationType.%s", async (kind, constant) => {
        await notify("msg", { typeToken: kind })
        expect(scripts[0]).toContain(`NotificationType.${constant}`)
    })

    test("escapes quotes and backslashes in message + title", async () => {
        await notify('he said "hi"\\done', { title: 'ti"tle\\x' })
        const g = scripts[0] as string
        expect(g).toContain('he said \\"hi\\"\\\\done')
        expect(g).toContain('ti\\"tle\\\\x')
        expect(g).not.toContain('"he said "hi"\\done"')
    })

    test("no actions -> no addAction, Bus.notify follows directly", async () => {
        await notify("hello")
        const g = scripts[0] as string
        expect(g).not.toContain("addAction")
        expect(g).toContain("NotificationType.INFORMATION)\n    Notifications.Bus.notify(n, project)")
    })

    test("open-url renders the browse closure", async () => {
        await notify("msg", { actions: [{ name: "open-url", arg: "https://example.com" }] })
        const g = scripts[0] as string
        expect(g).toContain('NotificationAction.createSimple("Open in browser"')
        expect(g).toContain('com.intellij.ide.BrowserUtil.browse("https://example.com")')
        expect(g).toContain("as Runnable))")
    })

    test("open-file renders the editor-open closure (re-fetched project, no shadow)", async () => {
        await notify("msg", { actions: [{ name: "open-file", arg: "/tmp/build.log" }] })
        const g = scripts[0] as string
        expect(g).toContain('NotificationAction.createSimple("Open file"')
        expect(g).toContain('LocalFileSystem.getInstance().findFileByPath("/tmp/build.log")')
        expect(g).toContain("if (vf == null) return")
        expect(g).toContain("FileEditorManager.getInstance(actionProject).openFile(vf, true)")
    })

    test("open-preview reuses the shared webpreview fragment verbatim (parity with previewUrl)", async () => {
        const url = "http://localhost:3000"
        await notify("msg", { actions: [{ name: "open-preview", arg: url }] })
        const g = scripts[0] as string
        expect(g).toContain('NotificationAction.createSimple("Open preview"')
        const fragment = webpreviewOpenBody(escapeGroovy(url), escapeGroovy(url), {
            projectVar: "actionProject",
            indent: " ".repeat(8)
        })
        expect(g).toContain(fragment)
    })

    test("multiple actions render in CLI order", async () => {
        await notify("msg", {
            actions: [
                { name: "open-preview", arg: "https://x" },
                { name: "open-file", arg: "/tmp" }
            ]
        })
        const g = scripts[0] as string
        expect((g.match(/addAction/g) ?? []).length).toBe(2)
        expect(g.indexOf('createSimple("Open preview"')).toBeLessThan(g.indexOf('createSimple("Open file"'))
    })

    test("action arg is escaped", async () => {
        await notify("msg", { actions: [{ name: "open-url", arg: 'https://x/?q="a\\b"' }] })
        const g = scripts[0] as string
        expect(g).toContain('browse("https://x/?q=\\"a\\\\b\\"")')
        expect(g).not.toContain('browse("https://x/?q="a\\b"")')
    })

    test.each(["open-file", "open-preview"])("%s re-fetch does not shadow the enclosing scope", async (action) => {
        await notify("msg", { actions: [{ name: action, arg: "x" }] })
        const g = scripts[0] as string
        expect(g).not.toContain("        def project ")
        expect(g).not.toContain("        def projects ")
        expect(g).toContain("        def actionProject ")
    })

    test("runs exactly one blocking ideScript with the right note", async () => {
        await notify("hello")
        expect(scripts.length).toBe(1)
        expect(notes[0]).toBe("notify: could not pop notification")
    })
})
