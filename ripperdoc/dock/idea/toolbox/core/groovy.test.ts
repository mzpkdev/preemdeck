/**
 * groovy.test.ts — the shared ideScript bridge. Covers the escape rules + the
 * run_groovy scaffolding contract (set_preview drives run_groovy in production;
 * here we test it directly via its deps seam).
 *
 * MOCK PATTERN A — dependency injection: runGroovy takes `launch`/`reapLater`/
 * `warn` seams. A launch spy reads the generated temp script back (proving the
 * groovy was spilled to a real `.groovy`), records argv + wait, and can raise to
 * exercise the graceful-degrade path.
 */

import { describe, expect, test } from "bun:test"
import { IdeaError, NotImplementedError } from "./errors.ts"
import { escapeGroovy, type RunGroovyDeps, runGroovy } from "./groovy.ts"

describe("escapeGroovy", () => {
    test("escapes backslashes FIRST, then double quotes", () => {
        // Order matters: an escaped quote's own backslash must not be re-escaped.
        expect(escapeGroovy('\\"')).toBe('\\\\\\"')
    })
    test("plain string is unchanged", () => {
        expect(escapeGroovy("/Users/me/notes.md")).toBe("/Users/me/notes.md")
    })
    test('a lone double quote becomes \\"', () => {
        expect(escapeGroovy('a"b')).toBe('a\\"b')
    })
    test("a lone backslash is doubled", () => {
        expect(escapeGroovy("a\\b")).toBe("a\\\\b")
    })
    test("quote and backslash together", () => {
        expect(escapeGroovy('we"ird\\name')).toBe('we\\"ird\\\\name')
    })
})

/** A launch spy: records argv + wait, reads the temp script, optionally throws. */
const launchSpy = (raises?: unknown) => {
    const calls: Array<{ args: string[]; wait: boolean }> = []
    const scripts: string[] = []
    const launch: NonNullable<RunGroovyDeps["launch"]> = async (args, options) => {
        calls.push({ args, wait: options?.wait ?? false })
        scripts.push(await Bun.file(args[1] ?? "").text())
        if (raises !== undefined) throw raises
        return {} as Bun.Subprocess
    }
    return { launch, calls, scripts }
}

/** Install the launch spy + a reap spy that records AND unlinks (leaves no temp). */
const deps = (spy: ReturnType<typeof launchSpy>): { deps: RunGroovyDeps; reaped: string[][]; warned: string[] } => {
    const reaped: string[][] = []
    const warned: string[] = []
    return {
        reaped,
        warned,
        deps: {
            launch: spy.launch,
            reapLater: (paths) => {
                const list = [...paths]
                reaped.push(list)
                for (const p of list) void Bun.file(p).unlink?.()
            },
            warn: (line) => warned.push(line)
        }
    }
}

describe("runGroovy", () => {
    test("spills the groovy to a temp .groovy and runs it blocking via ideScript", async () => {
        const spy = launchSpy()
        const { deps: d } = deps(spy)

        await runGroovy("println 'hi'", "note", d)

        expect(spy.calls.length).toBe(1)
        expect(spy.calls[0]?.wait).toBe(true)
        expect(spy.calls[0]?.args[0]).toBe("ideScript")
        expect(spy.calls[0]?.args[1]?.endsWith(".groovy")).toBe(true)
        // The exact groovy was written to the temp the launcher was handed.
        expect(spy.scripts[0]).toBe("println 'hi'")
    })

    test("hands the temp to the deferred reaper exactly once (same path as ideScript)", async () => {
        const spy = launchSpy()
        const { deps: d, reaped } = deps(spy)

        await runGroovy("x", "note", d)

        expect(reaped).toEqual([[spy.calls[0]?.args[1] ?? ""]])
    })

    for (const [id, err] of [
        ["IdeaError", new IdeaError("no JetBrains IDE in the process ancestry")],
        ["NotImplementedError", new NotImplementedError("resolveExecPath is not implemented for Linux yet")],
        ["OS error (ENOENT)", Object.assign(new Error("launcher missing"), { code: "ENOENT" })]
    ] as const) {
        test(`swallows ${id} with a stderr note and still reaps`, async () => {
            const spy = launchSpy(err)
            const { deps: d, reaped, warned } = deps(spy)

            // Never rejects (resolves to undefined).
            await expect(runGroovy("x", "preview: could not set preview", d)).resolves.toBeUndefined()
            expect(warned.join("")).toContain("preview:")
            // Even on the degrade path the temp is still scheduled for cleanup.
            expect(reaped.length).toBe(1)
        })
    }

    test("rethrows a non-swallowable error (a real bug, not a degrade case)", async () => {
        const spy = launchSpy(new TypeError("boom")) // no .code -> not an OS error
        const { deps: d, reaped } = deps(spy)

        await expect(runGroovy("x", "note", d)).rejects.toBeInstanceOf(TypeError)
        // The finally still ran, so the temp is reaped even when the error propagates.
        expect(reaped.length).toBe(1)
    })
})
