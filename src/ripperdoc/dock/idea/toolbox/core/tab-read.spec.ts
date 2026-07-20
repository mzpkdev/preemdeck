/**
 * tab-read.spec.ts — the tab-title read-back util, at three layers (mirrors
 * tab-focus.spec).
 *
 * groovyReadTitleByPid is pure string-gen: assert the escaped result path, the
 * QUOTED-string PIDS set matched via `String.valueOf(pid)`, the
 * GROOVY_RESULT_PENDING marker written synchronously before the async EDT body, a
 * matched tab as the ONLY writer of the result, the JsonOutput-escaped payload built
 * from `getDisplayName()`, and the shared reflection chain (GROOVY_TAB_HELPERS via
 * viewOf/pidOf) spliced in verbatim.
 *
 * parseTitle is fail-open: null / non-JSON / a missing-or-mistyped / empty title all
 * fold to null; a non-empty string title round-trips.
 *
 * readTabTitle is the dispatcher, driven through injected seams — no real IDE: an
 * empty pid set short-circuits to null with NO dispatch, a seam returning JSON
 * round-trips to the parsed title, the launchers are filtered to the launching
 * product before dispatch, and ANY rejecting seam degrades to null (never throws).
 */

import { describe, expect, it } from "bun:test"
import { IdeaError } from "./errors"
import { GROOVY_RESULT_PENDING } from "./groovy"
import { GROOVY_TAB_HELPERS } from "./tab-groovy"
import {
    groovyReadTitleByPid,
    groovyReadTitleByTargets,
    parseTitle,
    type ReadTabTitleDeps,
    readTabTitle
} from "./tab-read"

const context = describe

const WEBSTORM = "/Applications/WebStorm.app/Contents/MacOS/webstorm"
const PYCHARM = "/Applications/PyCharm.app/Contents/MacOS/pycharm"

describe("groovyReadTitleByPid", () => {
    context("the result-file path is escaped into the OUT literal", () => {
        it("doubles a backslash and escapes a quote so a crafted path cannot break out", () => {
            const g = groovyReadTitleByPid([1], '/tmp/we"ird\\r.json')
            expect(g).toContain('def OUT = "/tmp/we\\"ird\\\\r.json"')
            expect(g).not.toContain('/tmp/we"ird\\r.json')
        })

        it("leaves a plain path unchanged", () => {
            expect(groovyReadTitleByPid([1], "/tmp/r.json")).toContain('def OUT = "/tmp/r.json"')
        })
    })

    context("the PIDS set", () => {
        it("renders pids as QUOTED string literals in a Set, in order", () => {
            expect(groovyReadTitleByPid([123, 456], "/r.json")).toContain('def PIDS = ["123", "456"] as Set')
        })

        it("truncates a fractional pid before quoting", () => {
            expect(groovyReadTitleByPid([12.9], "/r.json")).toContain('def PIDS = ["12"] as Set')
        })

        it("is an empty Set for no pids", () => {
            expect(groovyReadTitleByPid([], "/r.json")).toContain("def PIDS = [] as Set")
        })

        it("compares the Long pid as a String via String.valueOf(pid)", () => {
            expect(groovyReadTitleByPid([1], "/r.json")).toContain("pids.contains(String.valueOf(pid))")
        })
    })

    context("the pending marker is written synchronously up front", () => {
        const g = groovyReadTitleByPid([1], "/r.json")

        it("writes the GROOVY_RESULT_PENDING sentinel before the async EDT body runs", () => {
            expect(g).toContain(`try { new File(OUT).text = '${GROOVY_RESULT_PENDING}' } catch (Throwable t) {}`)
            expect(g.indexOf(GROOVY_RESULT_PENDING)).toBeLessThan(g.indexOf("invokeLater"))
        })
    })

    context("only a matched tab overwrites the marker", () => {
        const g = groovyReadTitleByPid([1], "/r.json")

        it("starts result null and overwrites OUT from a finally only when result is non-null", () => {
            expect(g).toContain("def result = null")
            expect(g).toContain("if (result != null) new File(OUT).text = result")
        })

        it("assigns result ONLY past the pid-match gate (unmatched tabs keep the marker)", () => {
            const gate = g.indexOf("!matchesTab(view, PIDS, SESSION_IDS)) continue")
            const assign = g.indexOf("result = JsonOutput.toJson(")
            expect(gate).toBeGreaterThan(-1)
            expect(assign).toBeGreaterThan(gate)
        })

        it("builds the payload from getDisplayName via JsonOutput (so any title char is escaped)", () => {
            expect(g).toContain("import groovy.json.JsonOutput")
            expect(g).toContain(
                "result = JsonOutput.toJson([pid: String.valueOf(pid), title: String.valueOf(c.getDisplayName())])"
            )
        })
    })

    context("composes the shared reflection chain", () => {
        const g = groovyReadTitleByPid([1], "/r.json")

        it("splices GROOVY_TAB_HELPERS in verbatim (never a divergent copy)", () => {
            expect(g).toContain(GROOVY_TAB_HELPERS)
        })

        it("reaches each Content's view and pid through the shared viewOf/pidOf helpers", () => {
            expect(g).toContain("def view = viewOf(c)")
            expect(g).toContain("def pid = pidOf(view)")
        })
    })
})

describe("groovyReadTitleByTargets", () => {
    it("matches a tab by startup TERM_SESSION_ID", () => {
        const g = groovyReadTitleByTargets({ pids: [], termSessionIds: ["session-42"] }, "/r.json")
        expect(g).toContain("def SESSION_IDS = ['session-42'] as Set")
        expect(g).toContain("matchesTab(view, PIDS, SESSION_IDS)")
    })
})

describe("parseTitle", () => {
    context("fail-open on unusable input", () => {
        it("is null for null (a timeout/miss)", () => {
            expect(parseTitle(null)).toBeNull()
        })

        it.each([
            ["non-JSON garbage", "not json {"],
            ["an empty string", ""],
            ["JSON null (property read throws)", "null"],
            ["a JSON primitive", "true"],
            ["a JSON number", "42"],
            ["an object with no title", '{"pid":"77"}'],
            ["a non-string title", '{"title":123}'],
            ["an empty-string title", '{"title":""}']
        ] as [string, string][])("is null for %s", (_label, text) => {
            expect(parseTitle(text)).toBeNull()
        })
    })

    context("returns the title string when present", () => {
        it("reads a plain title", () => {
            expect(parseTitle('{"pid":"77","title":"work"}')).toBe("work")
        })

        it("preserves a glyph-prefixed title verbatim (the caller strips it)", () => {
            expect(parseTitle('{"title":"• tab-naming"}')).toBe("• tab-naming")
        })
    })
})

/**
 * Capture readTabTitle's dispatch through injected seams: record every seam call,
 * the launchers handed to the filter, and (per dispatch) the note, the filtered exec
 * set, and the Groovy the builder produced for a fixed result path.
 */
type ReadCaps = {
    deps: ReadTabTitleDeps
    calls: { owner: number; resolveExecs: number; filter: number; run: number }
    filterArgs: string[][]
    runArgs: Array<{ note: string; execPaths: string[]; groovy: string }>
}

const makeReadDeps = (
    opts: { owner?: string | null; execs?: string[]; filtered?: string[]; result?: string | null } = {}
): ReadCaps => {
    const calls = { owner: 0, resolveExecs: 0, filter: 0, run: 0 }
    const filterArgs: string[][] = []
    const runArgs: Array<{ note: string; execPaths: string[]; groovy: string }> = []
    const deps: ReadTabTitleDeps = {
        resolveExecPath: async () => {
            calls.owner++
            if (opts.owner) return opts.owner
            throw new IdeaError("owner unavailable")
        },
        resolveExecPaths: async () => {
            calls.resolveExecs++
            return [...(opts.execs ?? [])]
        },
        filterExecsForLaunchingProduct: (execPaths) => {
            calls.filter++
            filterArgs.push([...execPaths])
            return [...(opts.filtered ?? [...execPaths])]
        },
        runGroovyForResult: async (buildGroovy, note, execPaths) => {
            calls.run++
            runArgs.push({ note, execPaths: [...execPaths], groovy: buildGroovy("/fake/result.json") })
            return opts.result ?? null
        }
    }
    return { deps, calls, filterArgs, runArgs }
}

/** Deps whose one named seam throws; every other seam succeeds with a live-ish value. */
const rejectingDeps = (
    which: "resolveExecPaths" | "filterExecsForLaunchingProduct" | "runGroovyForResult"
): ReadTabTitleDeps => {
    const boom = new Error(`${which} boom`)
    return {
        resolveExecPath: async () => {
            throw new IdeaError("owner unavailable")
        },
        resolveExecPaths: async () => {
            if (which === "resolveExecPaths") throw boom
            return [WEBSTORM]
        },
        filterExecsForLaunchingProduct: (execPaths) => {
            if (which === "filterExecsForLaunchingProduct") throw boom
            return [...execPaths]
        },
        runGroovyForResult: async () => {
            if (which === "runGroovyForResult") throw boom
            return null
        }
    }
}

describe("readTabTitle (dispatch)", () => {
    context("an empty pid set short-circuits with no IDE contact", () => {
        it("resolves null and never dispatches", async () => {
            const cap = makeReadDeps({ execs: [WEBSTORM] })
            expect(await readTabTitle([], cap.deps)).toBeNull()
            expect(cap.calls.run).toBe(0)
            expect(cap.calls.owner).toBe(0)
            expect(cap.calls.resolveExecs).toBe(0)
            expect(cap.calls.filter).toBe(0)
        })

        it("short-circuits for empty shared targets", async () => {
            const cap = makeReadDeps({ execs: [WEBSTORM] })
            expect(await readTabTitle({ pids: [], termSessionIds: [] }, cap.deps)).toBeNull()
            expect(cap.calls.owner).toBe(0)
            expect(cap.calls.run).toBe(0)
        })
    })

    context("the resolved Linux owner", () => {
        it("dispatches directly without scanning running launchers", async () => {
            const cap = makeReadDeps({ owner: WEBSTORM, execs: [PYCHARM], result: '{"title":"Linux"}' })
            expect(await readTabTitle({ pids: [], termSessionIds: ["session-42"] }, cap.deps)).toBe("Linux")
            expect(cap.calls.owner).toBe(1)
            expect(cap.calls.resolveExecs).toBe(0)
            expect(cap.runArgs[0]?.execPaths).toEqual([WEBSTORM])
            expect(cap.runArgs[0]?.groovy).toContain("'session-42'")
        })
    })

    context("a live read round-trips through the seams", () => {
        it("returns the parsed title for a matched-tab JSON verdict", async () => {
            const cap = makeReadDeps({
                execs: [WEBSTORM],
                filtered: [WEBSTORM],
                result: '{"pid":"77","title":"• work"}'
            })
            expect(await readTabTitle([77], cap.deps)).toBe("• work")
            expect(cap.calls.run).toBe(1)
        })

        it("degrades to null when the round-trip yields null (timeout/miss)", async () => {
            const cap = makeReadDeps({ execs: [WEBSTORM], filtered: [WEBSTORM], result: null })
            expect(await readTabTitle([77], cap.deps)).toBeNull()
            expect(cap.calls.run).toBe(1) // it DID dispatch; the read just came back empty
        })

        it("builds the read groovy for the given pids and dispatches with the fail-open note", async () => {
            const cap = makeReadDeps({ execs: [WEBSTORM], filtered: [WEBSTORM], result: null })
            await readTabTitle([123], cap.deps)
            expect(cap.runArgs[0]?.groovy).toContain('def PIDS = ["123"] as Set')
            expect(cap.runArgs[0]?.groovy).toContain('def OUT = "/fake/result.json"')
            expect(cap.runArgs[0]?.note).toContain("tab-read")
        })
    })

    context("the launchers are filtered to the launching product", () => {
        it("passes the resolved launchers through the filter and dispatches only the filtered set", async () => {
            const cap = makeReadDeps({ execs: [WEBSTORM, PYCHARM], filtered: [WEBSTORM], result: null })
            await readTabTitle([123], cap.deps)
            expect(cap.calls.filter).toBe(1)
            expect(cap.filterArgs[0]).toEqual([WEBSTORM, PYCHARM])
            expect(cap.runArgs[0]?.execPaths).toEqual([WEBSTORM])
        })
    })

    context("never throws — every seam failure degrades to null", () => {
        it.each([
            "resolveExecPaths",
            "filterExecsForLaunchingProduct",
            "runGroovyForResult"
        ] as const)("resolves null (never rejects) when %s throws", async (which) => {
            await expect(readTabTitle([123], rejectingDeps(which))).resolves.toBeNull()
        })
    })
})
