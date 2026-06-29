import { describe, expect, it } from "bun:test"
import { IdeaError, NotImplementedError } from "./errors"
import { escapeGroovy, groovyProjectByCwd, type RunGroovyDeps, runGroovy, runGroovyOn } from "./groovy"

const context = describe

describe("escapeGroovy", () => {
    context("escaping rules", () => {
        it("escapes backslashes FIRST, then double quotes", () => {
            // Order matters: an escaped quote's own backslash must not be re-escaped.
            expect(escapeGroovy('\\"')).toBe('\\\\\\"')
        })
        it("plain string is unchanged", () => {
            expect(escapeGroovy("/Users/me/notes.md")).toBe("/Users/me/notes.md")
        })
        it('a lone double quote becomes \\"', () => {
            expect(escapeGroovy('a"b')).toBe('a\\"b')
        })
        it("a lone backslash is doubled", () => {
            expect(escapeGroovy("a\\b")).toBe("a\\\\b")
        })
        it("quote and backslash together", () => {
            expect(escapeGroovy('we"ird\\name')).toBe('we\\"ird\\\\name')
        })
    })
})

describe("groovyProjectByCwd", () => {
    context("rendering the project-by-cwd scan", () => {
        it("defaults: binds `project`, falls back to projects[0], scans `projects`/`cwd`", () => {
            const g = groovyProjectByCwd()
            expect(g).toContain("def project = projects[0]")
            expect(g).toContain("def bestLen = -1")
            expect(g).toContain("projects.each { p ->")
            expect(g).toContain('if (bp != null && (cwd == bp || cwd.startsWith(bp + "/")) && bp.length() > bestLen) {')
            expect(g).toContain("project = p")
        })

        it("null fallback + custom var = notify's application-level target", () => {
            const g = groovyProjectByCwd({ varName: "best", fallback: "null" })
            expect(g).toContain("def best = null")
            expect(g).toContain("best = p")
            expect(g).not.toContain("def project")
        })

        it("custom projectsVar / cwdVar are threaded through the loop", () => {
            const g = groovyProjectByCwd({
                varName: "actionProject",
                fallback: "actionProjects[0]",
                projectsVar: "actionProjects",
                cwdVar: "actionCwd"
            })
            expect(g).toContain("def actionProject = actionProjects[0]")
            expect(g).toContain("actionProjects.each { p ->")
            expect(g).toContain('actionCwd == bp || actionCwd.startsWith(bp + "/")')
        })

        it("indent prefixes every line and there is no trailing newline", () => {
            const g = groovyProjectByCwd({ indent: "    " })
            for (const line of g.split("\n")) {
                expect(line.startsWith("    ")).toBe(true)
            }
            expect(g.endsWith("\n")).toBe(false)
        })
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
    context("spilling and dispatching the temp script", () => {
        it("spills the groovy to a temp .groovy and runs it blocking via ideScript", async () => {
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

        it("hands the temp to the deferred reaper exactly once (same path as ideScript)", async () => {
            const spy = launchSpy()
            const { deps: d, reaped } = deps(spy)

            await runGroovy("x", "note", d)

            expect(reaped).toEqual([[spy.calls[0]?.args[1] ?? ""]])
        })
    })

    context("graceful degrade", () => {
        it.each([
            ["IdeaError", new IdeaError("no JetBrains IDE in the process ancestry")],
            ["NotImplementedError", new NotImplementedError("resolveExecPath is not implemented for Linux yet")],
            ["OS error (ENOENT)", Object.assign(new Error("launcher missing"), { code: "ENOENT" })]
        ] as [string, unknown][])("swallows %s with a stderr note and still reaps", async (_id, err) => {
            const spy = launchSpy(err)
            const { deps: d, reaped, warned } = deps(spy)

            // Never rejects (resolves to undefined).
            await expect(runGroovy("x", "preview: could not set preview", d)).resolves.toBeUndefined()
            expect(warned.join("")).toContain("preview:")
            // Even on the degrade path the temp is still scheduled for cleanup.
            expect(reaped.length).toBe(1)
        })

        it("rethrows a non-swallowable error (a real bug, not a degrade case)", async () => {
            const spy = launchSpy(new TypeError("boom")) // no .code -> not an OS error
            const { deps: d, reaped } = deps(spy)

            await expect(runGroovy("x", "note", d)).rejects.toBeInstanceOf(TypeError)
            // The finally still ran, so the temp is reaped even when the error propagates.
            expect(reaped.length).toBe(1)
        })
    })
})

describe("runGroovyOn", () => {
    context("dispatching to each exec path", () => {
        it("dispatches the SAME temp script to EACH exec path, blocking, via ideScript", async () => {
            // A launch that resolves + records each target binary (the existing launchSpy
            // ignores resolveExec; the per-target identity is what runGroovyOn adds).
            const targets: string[] = []
            const scripts: string[] = []
            const launch: NonNullable<RunGroovyDeps["launch"]> = async (args, options) => {
                targets.push((await options?.resolveExec?.()) ?? "")
                scripts.push(await Bun.file(args[1] ?? "").text())
                expect(options?.wait).toBe(true)
                expect(args[0]).toBe("ideScript")
                expect(args[1]?.endsWith(".groovy")).toBe(true)
                return {} as Bun.Subprocess
            }
            const reaped: string[][] = []
            await runGroovyOn("G", "note", ["/A/MacOS/webstorm", "/B/MacOS/pycharm"], {
                launch,
                reapLater: (paths) => {
                    const list = [...paths]
                    reaped.push(list)
                    for (const p of list) void Bun.file(p).unlink?.()
                }
            })

            expect(targets).toEqual(["/A/MacOS/webstorm", "/B/MacOS/pycharm"])
            expect(scripts).toEqual(["G", "G"]) // one temp, reused for every product
            expect(reaped.length).toBe(1) // reaped exactly once, after all dispatches
        })

        it("an empty target set is a no-op dispatch (temp written + reaped, no launch)", async () => {
            const spy = launchSpy()
            const { deps: d, reaped } = deps(spy)

            await runGroovyOn("x", "note", [], d)

            expect(spy.calls.length).toBe(0)
            expect(reaped.length).toBe(1)
        })
    })

    context("graceful degrade", () => {
        it("swallows a per-target failure and still dispatches to the rest, reaping once", async () => {
            // launchSpy(err) throws on EVERY call: with two targets both swallow, the loop
            // visits both, and the temp is reaped a single time.
            const spy = launchSpy(Object.assign(new Error("launcher missing"), { code: "ENOENT" }))
            const { deps: d, reaped, warned } = deps(spy)

            await expect(
                runGroovyOn("x", "notify: could not pop notification", ["/A/webstorm", "/B/pycharm"], d)
            ).resolves.toBeUndefined()
            expect(spy.calls.length).toBe(2) // a dead first IDE did not abort the second
            expect(warned.length).toBe(2)
            expect(warned.join("")).toContain("notify:")
            expect(reaped.length).toBe(1)
        })

        it("rethrows a non-swallowable error and stops (still reaps the temp)", async () => {
            const spy = launchSpy(new TypeError("boom")) // no .code -> a real bug
            const { deps: d, reaped } = deps(spy)

            await expect(runGroovyOn("x", "note", ["/A/webstorm", "/B/pycharm"], d)).rejects.toBeInstanceOf(TypeError)
            expect(spy.calls.length).toBe(1) // bailed on the first target
            expect(reaped.length).toBe(1)
        })
    })
})
