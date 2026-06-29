import { describe, expect, it } from "bun:test"
import * as path from "node:path"
import { groovyFor } from "./notify"

const context = describe

const run = async (
    args: string[],
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "notify.ts"), ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PREEMDECK_FORCE_IN_IDEA: "1", ...environment }
    })
    const [stdout, stderr] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text()
    ])
    const code = await subprocess.exited
    return { code, stdout, stderr }
}

describe("notify CLI", () => {
    context("on a live IDE", () => {
        it("exits 0 and writes nothing to stdout under --dry-run", async () => {
            const { code, stdout, stderr } = await run(["--dry-run", "build finished"])
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })

        it("threads --title and exits 0 under --dry-run", async () => {
            const { code, stdout } = await run(["--dry-run", "--title", "CI", "tests failed"])
            expect(code).toBe(0)
            expect(stdout).toBe("")
        })

        it.each([["info"], ["warning"], ["error"]] as [
            string
        ][])("accepts --type %s and exits 0 under --dry-run", async (kind) => {
            const { code } = await run(["--dry-run", "--type", kind, "a message"])
            expect(code).toBe(0)
        })

        it.each([
            ["open-url", ["--action", "open-url=https://example.com"]],
            ["open-file", ["--action", "open-file=/tmp/build.log"]],
            ["open-preview", ["--action", "open-preview=http://localhost:3000"]]
        ] as [string, string[]][])("accepts a vetted --action %s and exits 0 under --dry-run", async (_label, flag) => {
            const { code } = await run(["--dry-run", "a message", ...flag])
            expect(code).toBe(0)
        })

        it("accepts repeated --action flags and exits 0 under --dry-run", async () => {
            const { code } = await run([
                "--dry-run",
                "a message",
                "--action",
                "open-preview=https://x",
                "--action",
                "open-file=/tmp"
            ])
            expect(code).toBe(0)
        })

        it("accepts --all and exits 0 under --dry-run", async () => {
            const { code, stdout, stderr } = await run(["--dry-run", "--all", "a message"])
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })
    })

    context("without a live IDE", () => {
        it("exits 1 with the IdeaError on stderr, even with actions", async () => {
            const { code, stdout, stderr } = await run(["a message", "--action", "open-url=https://example.com"], {
                PREEMDECK_FORCE_IN_IDEA: "0"
            })
            expect(code).toBe(1)
            expect(stdout).toBe("")
            expect(stderr).toContain("no JetBrains IDE in the process ancestry")
        })
    })

    context("given malformed arguments", () => {
        it.each([
            ["a missing required message", [], 'An argument "message" is required.'],
            ["an unknown flag", ["--bogus", "a message"], 'An option "--bogus" is unknown.'],
            ["an off-whitelist --type", ["--type", "fatal", "a message"], "--type: invalid choice: 'fatal'"],
            [
                "an unknown --action",
                ["--action", "open-everything=x", "a message"],
                "--action: unknown action 'open-everything'"
            ],
            [
                "an --action missing its required arg",
                ["--action", "open-url", "a message"],
                "--action: action 'open-url' needs an argument"
            ]
        ] as [string, string[], string][])("exits 2 given %s", async (_label, args, fragment) => {
            const { code, stderr } = await run(args)
            expect(code).toBe(2)
            expect(stderr).toContain(fragment)
        })
    })

    context("with --help", () => {
        it("exits 0 and prints usage to stdout", async () => {
            const { code, stdout } = await run(["--help"])
            expect(code).toBe(0)
            expect(stdout).toContain("notify")
        })
    })
})

/**
 * groovyFor() is pure string-gen, so we assert the load-bearing structure
 * directly (no IDE, no ideScript): the per-target `fire` closure, both targeting
 * modes (single-window cwd match + its null fallback, and the all-windows branch),
 * and that the cwd literal is escaped like every other embedded string (the
 * injection guard). The cross-PRODUCT broadcast is NOT in this Groovy — it lives at
 * dispatch (one run per running product) and is covered by runGroovyOn +
 * resolveExecPaths.
 */
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

    context("single-window (terminal) targeting", () => {
        const g = groovyFor("T", "M", "info", [], "/Users/me/proj")

        it("does not emit the all-windows branch in single-window mode", () => {
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

    context("all-windows broadcast (allWindows = true)", () => {
        const g = groovyFor("T", "M", "info", [], "/Users/me/proj", true)

        it("fires a balloon in every open project window", () => {
            expect(g).toContain("projects.each { fire(it) }")
        })

        it("falls back to an application-level target when no project is open", () => {
            expect(g).toContain("if (projects.length == 0) fire(null)")
        })

        it("drops the single-window cwd targeting entirely", () => {
            expect(g).not.toContain("fire(best)")
            expect(g).not.toContain("bp.length() > bestLen")
            expect(g).not.toContain("def cwd =")
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
