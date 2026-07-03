/**
 * tab.spec.ts — the IDE-side half of rename-tab, at two layers.
 *
 * groovyRenameByPid is pure string-gen, so we assert the load-bearing structure
 * directly (no IDE): the SINGLE-quoted, injection-safe NAME literal (a `$`,
 * `${x}`, `'`, or `\` can neither interpolate nor break out), the `null` reset
 * token, the QUOTED-string PIDS set matched via `String.valueOf(pid)`, and the
 * `$`-bearing reflection literals kept single-quoted.
 *
 * renameTab is the dispatcher: an empty pid set is a no-op (no launcher scan, no
 * launch), a non-empty set dispatches the script to the launcher filtered to the
 * product that launched us, and a swallowable launch failure degrades without
 * throwing. All driven through injected seams (RenameTabDeps) — no real IDE.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { IdeaError, NotImplementedError } from "./errors"
import { groovyRenameByPid, type RenameTabDeps, renameTab } from "./tab"

const context = describe

const WEBSTORM = "/Applications/WebStorm.app/Contents/MacOS/webstorm"
const PYCHARM = "/Applications/PyCharm.app/Contents/MacOS/pycharm"

// A bare "$" spliced via real interpolation, so a "${...}" test payload is built
// by a genuine template literal rather than sitting as a `${` inside a plain
// string (Biome's noTemplateCurlyInString) — the very shape whose inertness in a
// single-quoted Groovy literal we are asserting.
const DOLLAR = "$"

describe("groovyRenameByPid", () => {
    context("the NAME literal is single-quoted and injection-safe", () => {
        it("keeps a `$` as an ordinary char (single quotes don't interpolate)", () => {
            const g = groovyRenameByPid([1], "a$b")
            expect(g).toContain("def NAME = 'a$b'")
        })

        it("keeps a dollar-brace GString-looking token inert and single-quoted", () => {
            const g = groovyRenameByPid([1], `a${DOLLAR}{x}b`)
            expect(g).toContain(`def NAME = 'a${DOLLAR}{x}b'`)
        })

        it("escapes an embedded single quote so a name cannot break out of the literal", () => {
            const g = groovyRenameByPid([1], "x'y")
            expect(g).toContain("def NAME = 'x\\'y'")
            // the unescaped, broken-out form must never appear
            expect(g).not.toContain("def NAME = 'x'y'")
        })

        it("escapes a backslash (doubled) so a trailing `\\` cannot escape the closing quote", () => {
            const g = groovyRenameByPid([1], "a\\b")
            expect(g).toContain("def NAME = 'a\\\\b'")
        })

        it("neutralizes a crafted breakout+interpolation payload in one name", () => {
            const g = groovyRenameByPid([1], `'; run() $x ${DOLLAR}{y} \\ end`)
            // quote escaped, backslash doubled, dollar and dollar-brace left literal inside single quotes
            expect(g).toContain(`def NAME = '\\'; run() $x ${DOLLAR}{y} \\\\ end'`)
            // the raw injection prefix must not survive unescaped
            expect(g).not.toContain("def NAME = ''; run()")
        })
    })

    context("null resets the user-defined title", () => {
        it("emits the bare `null` token (not the string 'null')", () => {
            const g = groovyRenameByPid([1, 2], null)
            expect(g).toContain("def NAME = null")
            expect(g).not.toContain("def NAME = 'null'")
        })
    })

    context("the PIDS set", () => {
        it("renders pids as QUOTED string literals in a Set, in order", () => {
            expect(groovyRenameByPid([123, 456], "x")).toContain('def PIDS = ["123", "456"] as Set')
        })

        it("truncates a fractional pid before quoting", () => {
            expect(groovyRenameByPid([12.9], "x")).toContain('def PIDS = ["12"] as Set')
        })

        it("is an empty Set for no pids", () => {
            expect(groovyRenameByPid([], "x")).toContain("def PIDS = [] as Set")
        })

        it("compares the Long pid as a String via String.valueOf(pid)", () => {
            expect(groovyRenameByPid([1], "x")).toContain("PIDS.contains(String.valueOf(pid))")
        })
    })

    context("the `$`-bearing reflection literals stay single-quoted", () => {
        const g = groovyRenameByPid([1], "x")

        it("reaches the synthetic enclosing instance via 'this$0'", () => {
            expect(g).toContain("getDeclaredField('this$0')")
        })

        it("finds the terminal panel via 'TerminalViewImpl$TerminalPanel' (in the shared viewOf closure)", () => {
            expect(g).toContain("findDesc(content.getComponent(), 'TerminalViewImpl$TerminalPanel')")
        })

        it("resolves each Content's view through the shared viewOf(c) helper", () => {
            expect(g).toContain("def view = viewOf(c)")
        })
    })
})

/**
 * Capture renameTab's dispatch: injected RenameTabDeps record the launcher scan,
 * every launch (with the per-product resolveExec target), the written script,
 * the reaped temp, and any warn line. `raises` makes each launch reject with a
 * given error, exercising the swallow path.
 */
const makeDeps = (
    opts: { execs?: string[]; raises?: unknown } = {}
): {
    deps: RenameTabDeps
    scripts: string[]
    launched: Array<{ args: string[]; wait: boolean; execPath: string | undefined }>
    reaped: string[][]
    warned: string[]
    counts: { resolve: number }
} => {
    const scripts: string[] = []
    const launched: Array<{ args: string[]; wait: boolean; execPath: string | undefined }> = []
    const reaped: string[][] = []
    const warned: string[] = []
    const counts = { resolve: 0 }
    const deps: RenameTabDeps = {
        resolveExecPaths: async () => {
            counts.resolve++
            return [...(opts.execs ?? [])]
        },
        writeTemp: async (groovy) => {
            scripts.push(groovy)
            return "/fake/rename.groovy"
        },
        launch: async (args, options) => {
            launched.push({ args, wait: options?.wait ?? false, execPath: await options?.resolveExec?.() })
            if (opts.raises !== undefined) {
                throw opts.raises
            }
            return {} as Bun.Subprocess
        },
        reapLater: (paths) => {
            reaped.push([...paths])
        },
        warn: (line) => {
            warned.push(line)
        }
    }
    return { deps, scripts, launched, reaped, warned, counts }
}

describe("renameTab (dispatch)", () => {
    const savedBundle = process.env.__CFBundleIdentifier
    afterEach(() => {
        if (savedBundle === undefined) delete process.env.__CFBundleIdentifier
        else process.env.__CFBundleIdentifier = savedBundle
    })

    it("is a no-op on an empty pid set — no launcher scan, no launch", async () => {
        const cap = makeDeps({ execs: [WEBSTORM] })
        await renameTab("anything", [], cap.deps)
        expect(cap.counts.resolve).toBe(0) // returns before even resolving launchers
        expect(cap.launched.length).toBe(0)
    })

    it("dispatches the pid script to the launcher of the launching product only", async () => {
        process.env.__CFBundleIdentifier = "com.jetbrains.WebStorm"
        const cap = makeDeps({ execs: [WEBSTORM, PYCHARM] })
        await renameTab("PR review", [123], cap.deps)

        expect(cap.launched.length).toBe(1)
        expect(cap.launched[0]?.execPath).toBe(WEBSTORM) // PyCharm filtered out
        expect(cap.launched[0]?.wait).toBe(true)
        expect(cap.launched[0]?.args).toEqual(["ideScript", "/fake/rename.groovy"])
        const g = cap.scripts[0] ?? ""
        expect(g).toContain("def NAME = 'PR review'")
        expect(g).toContain('def PIDS = ["123"] as Set')
        expect(cap.reaped).toEqual([["/fake/rename.groovy"]])
    })

    it("broadcasts to every running launcher when the launching product is unidentified", async () => {
        delete process.env.__CFBundleIdentifier // empty bundle -> no basename -> full set
        const cap = makeDeps({ execs: [WEBSTORM, PYCHARM] })
        await renameTab(null, [1], cap.deps)
        expect(cap.launched.map((l) => l.execPath)).toEqual([WEBSTORM, PYCHARM])
    })

    it.each([
        ["no-ide", new IdeaError("no JetBrains IDE in the process ancestry")],
        ["unimplemented-platform", new NotImplementedError("resolveExecPath is not implemented for Linux yet")],
        ["os-error", Object.assign(new Error("launcher missing"), { code: "ENOENT" })]
    ] as [string, unknown][])("never throws when the launch seam rejects (%s), and warns", async (_id, err) => {
        process.env.__CFBundleIdentifier = "com.jetbrains.WebStorm"
        const cap = makeDeps({ execs: [WEBSTORM], raises: err })
        await expect(renameTab("x", [7], cap.deps)).resolves.toBeUndefined()
        expect(cap.warned.join("")).toContain("rename-tab: could not rename tab")
        expect(cap.reaped.length).toBe(1) // temp still handed to the reaper
    })
})
