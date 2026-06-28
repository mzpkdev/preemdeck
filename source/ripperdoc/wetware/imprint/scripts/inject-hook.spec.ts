/**
 * inject-hook.spec.ts — Tmp-fixture FS for templates / host-tools files; DI
 * stdin/write for the envelope. Tests pass absolute temp paths, which resolve()
 * honors verbatim, so the explicit `pluginRoot` (the fixture dir) is irrelevant
 * to what gets read — it just avoids evaluating the real ENV.PLUGIN_ROOT default.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInjectionHook } from "../../../../common/hook-inject"
import { extractEventArg, renderTemplate } from "./inject-hook"

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
// `event` is defaulted here for the render-focused cases that don't pass --event.
// pluginRoot is passed explicitly (the fixture dir) — see the file header.
const runHookCli = async (argv: string[], stdinText: string): Promise<{ out: string }> => {
    const [cliEvent, rest] = extractEventArg(argv)
    const text = await renderTemplate(rest, dir)
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
        it("pulls --event and returns operands regardless of position", () => {
            expect(extractEventArg(["IMPRINT.md", "--event", "BeforeAgent", "hosts/h.md"])).toEqual([
                "BeforeAgent",
                ["IMPRINT.md", "hosts/h.md"]
            ])
        })
        it("honors only the first --event; later values fall through to operands", () => {
            // argvex is first-wins for a repeated flag; the surplus value "B" lands in operands.
            expect(extractEventArg(["--event", "A", "--event", "B"])).toEqual(["A", ["B"]])
        })
        it("yields null for a dangling --event", () => {
            expect(extractEventArg(["--event"])).toEqual([null, []])
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
            // main() errors when --event is absent; the guard keys off extractEventArg
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
    })
})
