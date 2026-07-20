import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { resolveHtmlDialogCliSource } from "./html-dialog"

const context = describe

let directory = ""
beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "preemdeck-html-dialog-"))
})
afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
})

const run = async (
    args: string[],
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, path.join(import.meta.dir, "html-dialog.ts"), ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PREEMDECK_FORCE_IN_IDEA: "1", ...environment }
    })
    const [stdout, stderr] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text()
    ])
    return { code: await subprocess.exited, stdout, stderr }
}

describe("resolveHtmlDialogCliSource", () => {
    it("returns literal HTML unchanged", async () => {
        expect(await resolveHtmlDialogCliSource({ html: "<p>Hi</p>" })).toEqual({ html: "<p>Hi</p>" })
    })

    it("returns a URL for validation by the shared core", async () => {
        expect(await resolveHtmlDialogCliSource({ url: "http://localhost:5173/form" })).toEqual({
            url: "http://localhost:5173/form"
        })
    })

    it("reads --html-file as UTF-8", async () => {
        const file = path.join(directory, "form.html")
        await writeFile(file, "<h1>Question</h1>", "utf8")
        expect(await resolveHtmlDialogCliSource({ htmlFile: file })).toEqual({ html: "<h1>Question</h1>" })
    })

    it.each([
        ["no source", {}],
        ["two sources", { html: "x", url: "http://localhost:3000" }]
    ])("rejects %s", async (_label, input) => {
        await expect(resolveHtmlDialogCliSource(input)).rejects.toThrow("exactly one")
    })
})

describe("html-dialog CLI", () => {
    context("under --dry-run", () => {
        it("validates literal HTML and prints the typed rehearsal result", async () => {
            const { code, stdout, stderr } = await run(["--html", "<p>Hi</p>", "--dry-run"])
            expect(code).toBe(0)
            expect(stdout).toBe('{"status":"unavailable","reason":"dry-run"}\n')
            expect(stderr).toBe("")
        })

        it("accepts an HTML file", async () => {
            const file = path.join(directory, "form.html")
            await writeFile(file, "<p>From file</p>", "utf8")
            const { code, stdout } = await run(["--html-file", file, "--dry-run"])
            expect(code).toBe(0)
            expect(JSON.parse(stdout)).toEqual({ status: "unavailable", reason: "dry-run" })
        })

        it("accepts a loopback URL and presentation overrides", async () => {
            const { code, stdout } = await run([
                "--url",
                "http://127.0.0.1:5173/form",
                "--title",
                "Question",
                "--width",
                "640",
                "--height",
                "420",
                "--timeout-ms",
                "12000",
                "--dry-run"
            ])
            expect(code).toBe(0)
            expect(JSON.parse(stdout)).toEqual({ status: "unavailable", reason: "dry-run" })
        })
    })

    context("without a live IDEA", () => {
        it("prints unavailable and exits 1", async () => {
            const { code, stdout, stderr } = await run(["--html", "<p>Hi</p>"], {
                PREEMDECK_FORCE_IN_IDEA: "0"
            })
            expect(code).toBe(1)
            expect(stdout).toBe('{"status":"unavailable","reason":"not-in-idea"}\n')
            expect(stderr).toBe("")
        })
    })

    context("given malformed input", () => {
        it.each([
            ["no source", [], "exactly one"],
            ["multiple sources", ["--html", "x", "--url", "http://localhost:3000"], "exactly one"],
            ["foreign URL", ["--url", "https://example.com"], "localhost"],
            ["empty HTML", ["--html", ""], "non-empty"],
            ["bad width", ["--html", "x", "--width", "wide"], "integer"]
        ] as [string, string[], string][])("exits 2 for %s", async (_label, args, fragment) => {
            const { code, stderr } = await run([...args, "--dry-run"])
            expect(code).toBe(2)
            expect(stderr).toContain(fragment)
        })
    })

    context("with --help", () => {
        it("documents all source forms and exits 0", async () => {
            const { code, stdout } = await run(["--help"])
            expect(code).toBe(0)
            expect(stdout).toContain("html-dialog")
            expect(stdout).toContain("--html-file")
            expect(stdout).toContain("--url")
        })
    })
})
