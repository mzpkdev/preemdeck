/**
 * tab-focus.spec.ts — the read counterpart of tab.spec, at three layers.
 *
 * groovyFocusByPid is pure string-gen, so we assert the load-bearing structure
 * directly (no IDE): the escaped result-file path, the QUOTED-string PIDS set
 * matched via `String.valueOf(pid)`, the GROOVY_RESULT_PENDING marker written
 * SYNCHRONOUSLY up front (before the async EDT body), a matched tab as the ONLY
 * writer that overwrites it, and the shared reflection chain (GROOVY_TAB_HELPERS,
 * reached through viewOf/pidOf) spliced in verbatim.
 *
 * parseFocus is fail-open: null / non-JSON / a missing-or-mistyped object all fold
 * to UNDETERMINED, each signal is read strictly (`=== true`), and `focused` is the
 * conjunction of the three parts.
 *
 * isTabFocused is the dispatcher, driven through injected seams (IsTabFocusedDeps)
 * — no real IDE: an empty pid set short-circuits to UNDETERMINED with NO dispatch,
 * a seam returning JSON round-trips to a parsed TabFocus, the launchers are filtered
 * to the launching product before dispatch, and ANY rejecting seam degrades to
 * UNDETERMINED rather than throwing.
 */

import { describe, expect, it } from "bun:test"
import { GROOVY_RESULT_PENDING } from "./groovy"
import { groovyFocusByPid, type IsTabFocusedDeps, isTabFocused, parseFocus, UNDETERMINED } from "./tab-focus"
import { GROOVY_TAB_HELPERS } from "./tab-groovy"

const context = describe

const WEBSTORM = "/Applications/WebStorm.app/Contents/MacOS/webstorm"
const PYCHARM = "/Applications/PyCharm.app/Contents/MacOS/pycharm"

describe("groovyFocusByPid", () => {
    context("the result-file path is escaped into the OUT literal", () => {
        it("doubles a backslash and escapes a quote so a crafted path cannot break out", () => {
            const g = groovyFocusByPid([1], '/tmp/we"ird\\r.json')
            expect(g).toContain('def OUT = "/tmp/we\\"ird\\\\r.json"')
            // the raw, unescaped path must never survive into the script
            expect(g).not.toContain('/tmp/we"ird\\r.json')
        })

        it("leaves a plain path unchanged", () => {
            expect(groovyFocusByPid([1], "/tmp/r.json")).toContain('def OUT = "/tmp/r.json"')
        })
    })

    context("the PIDS set", () => {
        it("renders pids as QUOTED string literals in a Set, in order", () => {
            expect(groovyFocusByPid([123, 456], "/r.json")).toContain('def PIDS = ["123", "456"] as Set')
        })

        it("truncates a fractional pid before quoting", () => {
            expect(groovyFocusByPid([12.9], "/r.json")).toContain('def PIDS = ["12"] as Set')
        })

        it("is an empty Set for no pids", () => {
            expect(groovyFocusByPid([], "/r.json")).toContain("def PIDS = [] as Set")
        })

        it("compares the Long pid as a String via String.valueOf(pid)", () => {
            expect(groovyFocusByPid([1], "/r.json")).toContain("PIDS.contains(String.valueOf(pid))")
        })
    })

    context("the pending marker is written synchronously up front", () => {
        const g = groovyFocusByPid([1], "/r.json")

        it("writes the GROOVY_RESULT_PENDING sentinel before the async EDT body runs", () => {
            expect(g).toContain(`try { new File(OUT).text = '${GROOVY_RESULT_PENDING}' } catch (Throwable t) {}`)
            // synchronous == emitted BEFORE the invokeLater the work runs inside
            expect(g.indexOf(GROOVY_RESULT_PENDING)).toBeLessThan(g.indexOf("invokeLater"))
        })
    })

    context("only a matched tab overwrites the marker", () => {
        const g = groovyFocusByPid([1], "/r.json")

        it("starts result null and overwrites OUT from a finally only when result is non-null", () => {
            expect(g).toContain("def result = null")
            expect(g).toContain("if (result != null) new File(OUT).text = result")
        })

        it("assigns result ONLY past the pid-match gate (unmatched tabs keep the marker)", () => {
            const gate = g.indexOf("!PIDS.contains(String.valueOf(pid))) continue")
            const assign = g.indexOf("result = '{\"pid\":'")
            expect(gate).toBeGreaterThan(-1)
            expect(assign).toBeGreaterThan(gate) // result is set after the continue-gate, never before
        })

        it("assembles the verdict JSON with the pid and the three signal fields", () => {
            expect(g).toContain("result = '{\"pid\":'")
            expect(g).toContain(',"tabSelected":')
            expect(g).toContain(',"toolWindowActive":')
            expect(g).toContain(',"frameFocused":')
        })
    })

    context("reads the three focus signals for the matched tab", () => {
        const g = groovyFocusByPid([1], "/r.json")

        it("tabSelected is our Content == the tool window's selected content", () => {
            expect(g).toContain("def tabSelected = (c == selected)")
        })

        it("toolWindowActive is the Terminal tool window's isActive()", () => {
            expect(g).toContain("def toolWindowActive = tw.isActive()")
        })

        it("frameFocused is the project frame's isFocused(), null-safe to false", () => {
            expect(g).toContain("def frameFocused = (frame == null) ? false : frame.isFocused()")
        })
    })

    context("composes the shared reflection chain", () => {
        const g = groovyFocusByPid([1], "/r.json")

        it("splices GROOVY_TAB_HELPERS in verbatim (never a divergent copy)", () => {
            expect(g).toContain(GROOVY_TAB_HELPERS)
        })

        it("reaches each Content's view and pid through the shared viewOf/pidOf helpers", () => {
            expect(g).toContain("def view = viewOf(c)")
            expect(g).toContain("def pid = pidOf(view)")
        })
    })
})

describe("parseFocus", () => {
    context("fail-open on unusable input", () => {
        it("is UNDETERMINED for null (a timeout/miss)", () => {
            expect(parseFocus(null)).toEqual(UNDETERMINED)
        })

        it.each([
            ["non-JSON garbage", "not json {"],
            ["an empty string", ""],
            ["JSON null (property read throws)", "null"],
            ["a JSON primitive", "true"],
            ["a JSON number", "42"]
        ] as [string, string][])("is UNDETERMINED for %s", (_label, text) => {
            expect(parseFocus(text)).toEqual(UNDETERMINED)
        })
    })

    context("reads each signal strictly (=== true)", () => {
        it("missing fields read as false", () => {
            expect(parseFocus('{"tabSelected":true}')).toEqual({
                focused: false,
                tabSelected: true,
                toolWindowActive: false,
                frameFocused: false
            })
        })

        it.each([
            ['the string "true"', '{"tabSelected":"true","toolWindowActive":"true","frameFocused":"true"}'],
            ["the numbers 1 / 0", '{"tabSelected":1,"toolWindowActive":0,"frameFocused":1}'],
            ["null values", '{"tabSelected":null,"toolWindowActive":null,"frameFocused":null}']
        ] as [string, string][])("mistyped signals (%s) read as false", (_label, text) => {
            expect(parseFocus(text)).toEqual(UNDETERMINED)
        })
    })

    context("focused is the conjunction of the three parts", () => {
        it("is true only when all three are boolean true", () => {
            expect(parseFocus('{"tabSelected":true,"toolWindowActive":true,"frameFocused":true}')).toEqual({
                focused: true,
                tabSelected: true,
                toolWindowActive: true,
                frameFocused: true
            })
        })

        it.each([
            ["tabSelected", '{"tabSelected":false,"toolWindowActive":true,"frameFocused":true}'],
            ["toolWindowActive", '{"tabSelected":true,"toolWindowActive":false,"frameFocused":true}'],
            ["frameFocused", '{"tabSelected":true,"toolWindowActive":true,"frameFocused":false}']
        ] as [string, string][])("is false when %s is false (the other two true)", (_falsePart, text) => {
            const focus = parseFocus(text)
            expect(focus.focused).toBe(false)
            // the two true parts are still reported so a caller can re-threshold on them
            const trueParts = [focus.tabSelected, focus.toolWindowActive, focus.frameFocused].filter(Boolean)
            expect(trueParts.length).toBe(2)
        })
    })
})

/**
 * Capture isTabFocused's dispatch through injected seams: record every seam call,
 * the launchers handed to the filter, and (per dispatch) the note, the filtered
 * exec set, and the Groovy the builder produced for a fixed result path.
 */
type FocusCaps = {
    deps: IsTabFocusedDeps
    calls: { resolvePids: number; resolveExecs: number; filter: number; run: number }
    filterArgs: string[][]
    runArgs: Array<{ note: string; execPaths: string[]; groovy: string }>
}

const makeFocusDeps = (
    opts: { pids?: number[]; execs?: string[]; filtered?: string[]; result?: string | null } = {}
): FocusCaps => {
    const calls = { resolvePids: 0, resolveExecs: 0, filter: 0, run: 0 }
    const filterArgs: string[][] = []
    const runArgs: Array<{ note: string; execPaths: string[]; groovy: string }> = []
    const deps: IsTabFocusedDeps = {
        resolveTabPids: async () => {
            calls.resolvePids++
            return [...(opts.pids ?? [])]
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
    which: "resolveTabPids" | "resolveExecPaths" | "filterExecsForLaunchingProduct" | "runGroovyForResult"
): IsTabFocusedDeps => {
    const boom = new Error(`${which} boom`)
    return {
        resolveTabPids: async () => {
            if (which === "resolveTabPids") throw boom
            return [123]
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

describe("isTabFocused (dispatch)", () => {
    context("an empty pid set short-circuits with no IDE contact", () => {
        it("resolves UNDETERMINED and never dispatches when the resolver yields no pids", async () => {
            const cap = makeFocusDeps({ pids: [], execs: [WEBSTORM] })
            expect(await isTabFocused(undefined, cap.deps)).toEqual(UNDETERMINED)
            expect(cap.calls.resolvePids).toBe(1)
            expect(cap.calls.run).toBe(0) // no round-trip dispatched
            expect(cap.calls.resolveExecs).toBe(0)
            expect(cap.calls.filter).toBe(0)
        })

        it("short-circuits on an explicit empty pid array without even resolving pids", async () => {
            const cap = makeFocusDeps({ execs: [WEBSTORM] })
            expect(await isTabFocused([], cap.deps)).toEqual(UNDETERMINED)
            expect(cap.calls.resolvePids).toBe(0) // `pids ?? resolve()` skips the resolver
            expect(cap.calls.run).toBe(0)
        })
    })

    context("a live read round-trips through the seams", () => {
        it("returns the parsed TabFocus for a focused JSON verdict", async () => {
            const cap = makeFocusDeps({
                pids: [123],
                execs: [WEBSTORM],
                filtered: [WEBSTORM],
                result: '{"pid":123,"tabSelected":true,"toolWindowActive":true,"frameFocused":true}'
            })
            expect(await isTabFocused(undefined, cap.deps)).toEqual({
                focused: true,
                tabSelected: true,
                toolWindowActive: true,
                frameFocused: true
            })
            expect(cap.calls.run).toBe(1)
        })

        it("folds a partial verdict through the conjunction (not focused)", async () => {
            const cap = makeFocusDeps({
                pids: [123],
                execs: [WEBSTORM],
                filtered: [WEBSTORM],
                result: '{"tabSelected":true,"toolWindowActive":true,"frameFocused":false}'
            })
            const focus = await isTabFocused(undefined, cap.deps)
            expect(focus.focused).toBe(false)
            expect(focus.frameFocused).toBe(false)
        })

        it("degrades to UNDETERMINED when the round-trip yields null (timeout/miss)", async () => {
            const cap = makeFocusDeps({ pids: [123], execs: [WEBSTORM], filtered: [WEBSTORM], result: null })
            expect(await isTabFocused(undefined, cap.deps)).toEqual(UNDETERMINED)
            expect(cap.calls.run).toBe(1) // it DID dispatch; the read just came back empty
        })

        it("builds the focus groovy for the resolved pids and dispatches with the fail-open note", async () => {
            const cap = makeFocusDeps({ pids: [123], execs: [WEBSTORM], filtered: [WEBSTORM], result: null })
            await isTabFocused(undefined, cap.deps)
            expect(cap.runArgs[0]?.groovy).toContain('def PIDS = ["123"] as Set')
            expect(cap.runArgs[0]?.groovy).toContain('def OUT = "/fake/result.json"')
            expect(cap.runArgs[0]?.note).toContain("tab-focused")
        })
    })

    context("the launchers are filtered to the launching product", () => {
        it("passes the resolved launchers through the filter and dispatches only the filtered set", async () => {
            const cap = makeFocusDeps({ pids: [123], execs: [WEBSTORM, PYCHARM], filtered: [WEBSTORM], result: null })
            await isTabFocused(undefined, cap.deps)
            expect(cap.calls.filter).toBe(1)
            expect(cap.filterArgs[0]).toEqual([WEBSTORM, PYCHARM]) // the full resolved set went in
            expect(cap.runArgs[0]?.execPaths).toEqual([WEBSTORM]) // only the filtered product was dispatched
        })
    })

    context("explicit pids bypass the resolver", () => {
        it("uses the given pids and never calls resolveTabPids", async () => {
            const cap = makeFocusDeps({ execs: [WEBSTORM], filtered: [WEBSTORM], result: null })
            await isTabFocused([777], cap.deps)
            expect(cap.calls.resolvePids).toBe(0)
            expect(cap.runArgs[0]?.groovy).toContain('def PIDS = ["777"] as Set')
        })
    })

    context("never throws — every seam failure degrades to UNDETERMINED", () => {
        it.each([
            "resolveTabPids",
            "resolveExecPaths",
            "filterExecsForLaunchingProduct",
            "runGroovyForResult"
        ] as const)("resolves UNDETERMINED (never rejects) when %s throws", async (which) => {
            await expect(isTabFocused(undefined, rejectingDeps(which))).resolves.toEqual(UNDETERMINED)
        })
    })
})
