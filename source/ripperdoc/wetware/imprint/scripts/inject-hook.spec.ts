/**
 * inject-hook.spec.ts — Tmp-fixture FS for templates / host-tools files; DI
 * stdin/write for the envelope. Absolute temp paths are honored verbatim
 * (resolve()'s "absolute wins"), which the suite relies on.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInjectionHook } from "../../../../common/hook-inject.ts"
import { extractEventArg, renderTemplate, resolveTemplateArg } from "./inject-hook.ts"

const context = describe

let dir = ""
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "preemdeck-injhook-"))
})
afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

let counter = 0
const writeTmp = async (content: string): Promise<string> => {
    const p = join(dir, `f${counter++}.md`)
    await writeFile(p, content)
    return p
}

// Mirror main(): split --event, then render, then emit with the injected stdin.
// `event` is required now; default it here for the render-focused cases that
// don't pass --event (the missing-`--event` guard is covered separately).
const runHookCli = async (argv: string[], stdinText: string): Promise<{ out: string }> => {
    const [cliEvent, rest] = extractEventArg(argv)
    // pluginRoot is irrelevant here: tests pass absolute paths, which resolve() honors verbatim.
    const text = await renderTemplate(rest)
    let out = ""
    await runInjectionHook({
        event: cliEvent ?? "UserPromptSubmit",
        stdin: { text: () => Promise.resolve(stdinText) },
        write: (l) => {
            out = l
        },
        render: () => text
    })
    return { out }
}

describe("inject-hook", () => {
    context("extracting the --event arg", () => {
        it("pulls the first --event and leaves the rest", () => {
            expect(extractEventArg(["IMPRINT.md", "--event", "BeforeAgent", "hosts/h.md"])).toEqual([
                "BeforeAgent",
                ["IMPRINT.md", "hosts/h.md"]
            ])
        })
        it("honors only the first --event", () => {
            expect(extractEventArg(["--event", "A", "--event", "B"])).toEqual(["A", ["--event", "B"]])
        })
        it("yields null for a dangling --event", () => {
            expect(extractEventArg(["--event"])).toEqual([null, []])
        })
    })

    context("resolving the template arg", () => {
        it("maps --file <name> to <NAME>.md", () => {
            expect(resolveTemplateArg(["--file", "imprint", "x"])).toEqual(["IMPRINT.md", ["x"]])
        })
        it("uses a bare path verbatim", () => {
            expect(resolveTemplateArg(["IMPRINT.md", "hosts/h.md"])).toEqual(["IMPRINT.md", ["hosts/h.md"]])
        })
        it("yields null for no args", () => {
            expect(resolveTemplateArg([])).toEqual([null, []])
        })
        it("yields null for --file with no name", () => {
            expect(resolveTemplateArg(["--file"])).toEqual([null, []])
        })
    })

    context("running the CLI", () => {
        it("substitutes {{host_tools}}", async () => {
            const template = await writeTmp("# T\n\n{{host_tools}}\n")
            const host = await writeTmp("HOST_TOOLS_MARKER")
            const { out } = await runHookCli([template, host], "{}")
            const ctx = JSON.parse(out).hookSpecificOutput.additionalContext
            expect(ctx).toContain("HOST_TOOLS_MARKER")
            expect(ctx).not.toContain("{{host_tools}}")
        })

        it("supplies the fallback event from --event", async () => {
            const template = await writeTmp("body\n")
            const { out } = await runHookCli([template, "--event", "BeforeAgent"], "{}")
            expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("BeforeAgent")
        })

        it("lets a stdin event win over the flag", async () => {
            const template = await writeTmp("body\n")
            const { out } = await runHookCli(
                [template, "--event", "BeforeAgent"],
                '{"hook_event_name":"UserPromptSubmit"}'
            )
            expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
        })

        it("leaves no event for the runner when --event is omitted (guarded by main)", () => {
            // main() now errors when --event is absent; the guard keys off extractEventArg
            // returning null. There is no implicit default anymore.
            const [cliEvent, rest] = extractEventArg(["body.md"])
            expect(cliEvent).toBeNull()
            expect(rest).toEqual(["body.md"])
        })

        it("is a {} no-op for a missing template", async () => {
            const { out } = await runHookCli(["/nonexistent/template/____.md"], "{}")
            expect(out).toBe("{}")
        })

        it("collapses a missing host-tools file to empty and still emits", async () => {
            const template = await writeTmp("before {{host_tools}} after\n")
            const { out } = await runHookCli([template, "/nonexistent/host/____.md"], "{}")
            const ctx = JSON.parse(out).hookSpecificOutput.additionalContext
            expect(ctx).not.toContain("{{host_tools}}")
            expect(ctx).toContain("before")
            expect(ctx).toContain("after")
        })

        it("is a {} no-op for a whitespace-only template", async () => {
            const template = await writeTmp("   \n\t\n")
            const { out } = await runHookCli([template], "{}")
            expect(out).toBe("{}")
        })

        it("emits a template without the placeholder unchanged", async () => {
            const template = await writeTmp("just some static body\n")
            const { out } = await runHookCli([template], "{}")
            expect(JSON.parse(out).hookSpecificOutput.additionalContext).toBe("just some static body")
        })

        it("parses --file imprint --event SessionStart with --event present", async () => {
            // Resolves IMPRINT.md against the real plugin root (renderTemplate default).
            const [cliEvent, rest] = extractEventArg(["--file", "imprint", "--event", "SessionStart"])
            expect(cliEvent).toBe("SessionStart")
            const text = await renderTemplate(rest)
            let out = ""
            await runInjectionHook({
                event: cliEvent as string,
                stdin: { text: () => Promise.resolve("{}") },
                write: (l) => {
                    out = l
                },
                render: () => text
            })
            expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("SessionStart")
        })
    })
})
