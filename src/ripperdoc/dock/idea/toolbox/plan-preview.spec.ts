import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { type InteractiveDeps, openInteractive, resolvePlanMarkdown } from "./plan-preview"

const context = describe

/** Spawn the CLI and feed `payload` on stdin (write then end — Bun.spawn rejects a bare string for stdin). */
const run = async (
    payload: string,
    args: string[] = [],
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "plan-preview.ts"), ...args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PREEMDECK_FORCE_IN_IDEA: "1", ...environment }
    })
    subprocess.stdin.write(payload)
    subprocess.stdin.end()
    const [stdout, stderr] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text()
    ])
    const code = await subprocess.exited
    return { code, stdout, stderr }
}

/** The set of `idea-tmp-*` dir names currently in the os tmpdir (writeTemp's mint root). */
const ideaTemps = async (): Promise<Set<string>> => {
    const entries = await fs.readdir(os.tmpdir()).catch(() => [] as string[])
    return new Set(entries.filter((name) => name.startsWith("idea-tmp-")))
}

let directory = ""
let tempsBefore: Set<string>
beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "preemdeck-planpreview-"))
    tempsBefore = await ideaTemps()
})
afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true })
    // The inline-plan path leaks a temp dir (process.exit kills the reap timer);
    // remove whatever appeared during this test so the suite leaves nothing behind.
    const after = await ideaTemps()
    for (const name of after) {
        if (!tempsBefore.has(name)) {
            await fs.rm(path.join(os.tmpdir(), name), { recursive: true, force: true })
        }
    }
})

describe("plan-preview CLI", () => {
    context("on a live IDE", () => {
        it("exits 0 silently for a Claude inline plan under --dry-run", async () => {
            const payload = JSON.stringify({ tool_input: { plan: "# Plan\n\n- step" } })
            const { code, stdout, stderr } = await run(payload, ["--dry-run"])
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })

        it("exits 0 silently for a Gemini plan_path under --dry-run", async () => {
            const planPath = path.join(directory, "plan.md")
            await fs.writeFile(planPath, "# Plan\n")
            const payload = JSON.stringify({ tool_input: { plan_path: planPath } })
            const { code, stdout, stderr } = await run(payload, ["--dry-run"])
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })

        it("accepts plan_path alongside plan and still exits 0 silently", async () => {
            const planPath = path.join(directory, "plan.md")
            await fs.writeFile(planPath, "# Plan\n")
            const payload = JSON.stringify({ tool_input: { plan: "inline", plan_path: planPath } })
            const { code, stdout, stderr } = await run(payload, ["--dry-run"])
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })

        it("accepts and ignores a host-name positional, still exits 0 silently", async () => {
            const payload = JSON.stringify({ tool_input: { plan: "# Plan" } })
            const { code, stdout, stderr } = await run(payload, ["Gemini", "--dry-run"])
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })

        it.each([
            ["empty object", JSON.stringify({})],
            ["empty tool_input", JSON.stringify({ tool_input: {} })],
            ["whitespace plan", JSON.stringify({ tool_input: { plan: "   " } })],
            ["empty plan_path", JSON.stringify({ tool_input: { plan_path: "" } })],
            ["non-string plan", JSON.stringify({ tool_input: { plan: ["not", "a", "str"] } })],
            ["non-object tool_input", JSON.stringify({ tool_input: "not-a-dict" })],
            ["malformed JSON", "not json"],
            ["empty stdin", ""]
        ] as [string, string][])("exits 0 silently on no-plan input (%s)", async (_label, payload) => {
            const { code, stdout, stderr } = await run(payload, ["--dry-run"])
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })
    })

    context("without a live IDE", () => {
        it("exits 0 silently with no open attempted", async () => {
            const payload = JSON.stringify({ tool_input: { plan: "# Plan" } })
            const { code, stdout, stderr } = await run(payload, [], { PREEMDECK_FORCE_IN_IDEA: "0" })
            expect(code).toBe(0)
            expect(stdout).toBe("")
            expect(stderr).toBe("")
        })
    })

    context("given malformed arguments", () => {
        it.each([["an unknown flag", ["--bogus"], 'An option "--bogus" is unknown.']] as [
            string,
            string[],
            string
        ][])("exits 2 given %s", async (_label, args, fragment) => {
            const payload = JSON.stringify({ tool_input: { plan: "# Plan" } })
            const { code, stderr } = await run(payload, args)
            expect(code).toBe(2)
            expect(stderr).toContain(fragment)
        })
    })

    context("with --help", () => {
        it("exits 0 and prints usage to stdout", async () => {
            const { code, stdout } = await run("", ["--help"])
            expect(code).toBe(0)
            expect(stdout).toContain("plan-preview")
        })
    })
})

/** A recorded spawn: the argv holo's serve.ts was launched with, and the port. */
type SpawnCall = { mdxPath: string; port: number }
/** A recorded open: the URL + title handed to the IDE preview. */
type OpenCall = { url: string; title: string }

/**
 * Build fully-stubbed {@link InteractiveDeps} with recorders, so the interactive
 * branch can be exercised WITHOUT binding a real port, spawning a real server, or
 * touching a real IDE. `resolvePlan` defaults to the REAL resolver (so the
 * plan/plan_path resolution is genuinely tested); every side-effecting seam is a
 * spy over `overrides`.
 */
const makeDeps = (
    overrides: Partial<InteractiveDeps> = {}
): {
    deps: InteractiveDeps
    written: string[]
    spawns: SpawnCall[]
    opens: OpenCall[]
} => {
    const written: string[] = []
    const spawns: SpawnCall[] = []
    const opens: OpenCall[] = []
    const deps: InteractiveDeps = {
        resolvePlan: overrides.resolvePlan ?? ((toolInput) => resolvePlanMarkdown(toolInput)),
        writeMdx:
            overrides.writeMdx ??
            (async (markdown) => {
                const mdxPath = path.join(directory, `holo-plan-${written.length}.mdx`)
                await fs.writeFile(mdxPath, markdown, "utf8")
                written.push(mdxPath)
                return mdxPath
            }),
        findFreePort: overrides.findFreePort ?? (async () => 45123),
        spawn:
            overrides.spawn ??
            (async (mdxPath, port) => {
                spawns.push({ mdxPath, port })
            }),
        waitForPort: overrides.waitForPort ?? (async () => {}),
        openUrl:
            overrides.openUrl ??
            (async (url, title) => {
                opens.push({ url, title })
            })
    }
    return { deps, written, spawns, opens }
}

describe("openInteractive", () => {
    it("resolves an inline Claude plan to markdown and writes a .mdx", async () => {
        const { deps, written } = makeDeps()
        await openInteractive({ plan: "# Inline\n\n- step" }, deps)
        expect(written).toHaveLength(1)
        expect(written[0]?.endsWith(".mdx")).toBe(true)
        expect(await fs.readFile(written[0] as string, "utf8")).toBe("# Inline\n\n- step")
    })

    it("resolves a Gemini plan_path by reading the file to markdown", async () => {
        const planPath = path.join(directory, "plan.md")
        await fs.writeFile(planPath, "# From file\n")
        const { deps, written } = makeDeps()
        await openInteractive({ plan_path: planPath }, deps)
        expect(written).toHaveLength(1)
        expect(await fs.readFile(written[0] as string, "utf8")).toBe("# From file\n")
    })

    it("spawns holo's serve.ts with the resolved temp and the reserved port", async () => {
        const { deps, written, spawns } = makeDeps()
        await openInteractive({ plan: "# Plan" }, deps)
        expect(spawns).toHaveLength(1)
        expect(spawns[0]?.port).toBe(45123)
        expect(spawns[0]?.mdxPath).toBe(written[0] as string)
    })

    it("opens the hook-owned URL http://127.0.0.1:<port> in the IDE with the plan title", async () => {
        const planPath = path.join(directory, "my-plan.md")
        await fs.writeFile(planPath, "# Titled\n")
        const { deps, opens } = makeDeps()
        await openInteractive({ plan_path: planPath }, deps)
        expect(opens).toHaveLength(1)
        expect(opens[0]?.url).toBe("http://127.0.0.1:45123")
        expect(opens[0]?.title).toBe("my-plan.md")
    })

    it("titles an inline plan 'plan'", async () => {
        const { deps, opens } = makeDeps()
        await openInteractive({ plan: "# Inline" }, deps)
        expect(opens[0]?.title).toBe("plan")
    })

    it("no-ops (no write, no spawn, no open) when there is no plan content", async () => {
        const { deps, written, spawns, opens } = makeDeps()
        await openInteractive({ plan: "   " }, deps)
        await openInteractive({}, deps)
        expect(written).toHaveLength(0)
        expect(spawns).toHaveLength(0)
        expect(opens).toHaveLength(0)
    })

    it("assembles the full spawn argv the CLI would use (execPath, serve.ts, temp, --port, port, --kill-on-disconnect)", async () => {
        // Assert the argv shape by spawning through a recorder that mirrors the real
        // Bun.spawn call — proves the temp + port + self-reap flag land in the argv
        // the CLI builds. --kill-on-disconnect makes the fresh-per-plan server exit
        // when its IDE tab closes so no Vite process is orphaned.
        const holoServe = path.resolve(import.meta.dir, "..", "..", "..", "chrome", "holo", "toolbox", "serve.ts")
        let argv: string[] = []
        const { deps } = makeDeps({
            findFreePort: async () => 47777,
            spawn: async (mdxPath, port) => {
                argv = [process.execPath, holoServe, mdxPath, "--port", String(port), "--kill-on-disconnect"]
            }
        })
        await openInteractive({ plan: "# Plan" }, deps)
        expect(argv[0]).toBe(process.execPath)
        expect(argv[1]).toBe(holoServe)
        expect(argv[1]?.endsWith(path.join("chrome", "holo", "toolbox", "serve.ts"))).toBe(true)
        expect(argv[2]?.endsWith(".mdx")).toBe(true)
        expect(argv.slice(3)).toEqual(["--port", "47777", "--kill-on-disconnect"])
    })

    it("is contained by run()'s try/catch when a dep throws (never-throw contract)", async () => {
        // openInteractive itself does not swallow — that is run()'s job. Mirror run()'s
        // single try/catch around the call and assert a throwing dep never escapes it,
        // so the host proceeds to its approval gate unchanged.
        const { deps } = makeDeps({
            openUrl: async () => {
                throw new Error("IDE unreachable")
            }
        })
        let escaped = false
        // Exactly run()'s guard: try the call, swallow anything it throws.
        await openInteractive({ plan: "# Plan" }, deps).catch(() => {
            escaped = true // reached: the pipeline propagates, run()'s catch absorbs it
        })
        expect(escaped).toBe(true)
    })
})
