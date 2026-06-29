import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { openFile } from "./open-file"

const context = describe

const FAKE_CHILD = undefined as unknown as Bun.Subprocess

const ORIGINAL = "ORIGINAL\n"

const run = async (
    args: string[],
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "open-file.ts"), ...args], {
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

let directory = ""
beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "preemdeck-openfile-"))
})
afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true })
})

describe("open-file CLI", () => {
    context("on a live IDE", () => {
        it("exits 0 and writes nothing to stdout under --dry-run", async () => {
            const target = path.join(directory, "thing.ts")
            await fs.writeFile(target, ORIGINAL)
            const { code, stdout, stderr } = await run(["--dry-run", target])
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })

        it("prints the file contents back to stdout under --wait", async () => {
            const target = path.join(directory, "thing.ts")
            await fs.writeFile(target, ORIGINAL)
            const { code, stdout } = await run(["--wait", "--dry-run", target])
            expect(code).toBe(0)
            expect(stdout).toBe(ORIGINAL)
        })
    })

    context("without a live IDE", () => {
        it("exits 1 with the IdeaError on stderr", async () => {
            const target = path.join(directory, "thing.ts")
            await fs.writeFile(target, ORIGINAL)
            const { code, stdout, stderr } = await run([target], { PREEMDECK_FORCE_IN_IDEA: "0" })
            expect(code).toBe(1)
            expect(stdout).toBe("")
            expect(stderr).toContain("no JetBrains IDE in the process ancestry")
        })
    })

    context("given malformed arguments", () => {
        it.each([
            ["a non-integer --line", ["--line", "abc", "foo.txt"], "--line must be an integer, got 'abc'"],
            ["an unknown flag", ["--bogus", "foo.txt"], 'An option "--bogus" is unknown.'],
            ["a missing required path", [], 'An argument "path" is required.']
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
            expect(stdout).toContain("open-file")
        })
    })
})

/**
 * The load-bearing invariant: with { wait, preview } the preview flip must fire
 * WHILE the blocking launch is still pending — never after it resolves. Under
 * --wait the IDE's native --wait makes launch() block until the tab closes; if
 * setPreview ran only after that await, it would reopen the just-closed file in
 * preview (and the user would never see the preview while editing).
 *
 * We drive it through the injectable `deps` seam (no IDE): launch blocks on a
 * gate that setPreview releases — mimicking the user closing the tab once the
 * preview is up. A regression to `await launch` BEFORE setPreview would deadlock
 * this test (launch awaits a gate only setPreview can release, but setPreview
 * can't run until launch returns), so the short timeout turns the old ordering
 * into a fast, unambiguous failure.
 */
describe("openFile orchestration", () => {
    it("flips preview while the launch is still blocking, then reads the file back", async () => {
        const trace: string[] = []
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })

        const target = `${import.meta.dir}/open-file.spec.ts`
        const out = await openFile(target, {
            wait: true,
            preview: true,
            deps: {
                launch: async () => {
                    trace.push("launch:start")
                    await gate
                    trace.push("launch:end")
                    return FAKE_CHILD
                },
                setPreview: async () => {
                    trace.push("preview")
                    release() // user closes the tab once the preview is up → launch unblocks
                }
            }
        })

        expect(trace).toEqual(["launch:start", "preview", "launch:end"])
        // wait path reads the real file back; this test file starts with the import line
        expect(out?.startsWith("import")).toBe(true)
    }, 2000)

    it("does not flip preview when preview is not requested", async () => {
        const trace: string[] = []
        const out = await openFile(`${import.meta.dir}/open-file.spec.ts`, {
            wait: true,
            preview: false,
            deps: {
                launch: async () => {
                    trace.push("launch")
                    return FAKE_CHILD
                },
                setPreview: async () => {
                    trace.push("preview")
                    return undefined
                }
            }
        })
        expect(trace).toEqual(["launch"])
        expect(out?.startsWith("import")).toBe(true)
    })

    it("returns null on the fire-and-forget path but still flips preview", async () => {
        const trace: string[] = []
        const out = await openFile(`${import.meta.dir}/open-file.spec.ts`, {
            wait: false,
            preview: true,
            deps: {
                launch: async () => {
                    trace.push("launch")
                    return FAKE_CHILD
                },
                setPreview: async () => {
                    trace.push("preview")
                    return undefined
                }
            }
        })
        expect(trace).toEqual(["launch", "preview"])
        expect(out).toBeNull()
    })
})
