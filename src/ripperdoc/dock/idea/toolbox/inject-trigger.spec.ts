/**
 * inject-trigger.spec.ts — the generic trigger-directive injector.
 *
 * Tmp-fixture FS for templates; DI stdin/write for the envelope (mirrors
 * inject-tab-name.spec, minus the tab-name append). Tests pass absolute temp paths,
 * which resolve() honors verbatim, so the explicit `pluginRoot` just avoids evaluating
 * the real ENV.PLUGIN_ROOT default. The throttle-gating context redirects
 * ENV.PREEMDECK_ROOT (where throttle persists counters) at a temp dir and composes
 * render exactly as main() does (text && throttle -> text).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInjectionHook } from "../../../../common/hook-inject"
import { throttle } from "../../../../common/hooks"
import { ENV } from "../../../../common/preemdeck"
import { extractArgs, renderTemplate } from "./inject-trigger"

const context = describe

let dir = ""
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "preemdeck-injtrig-"))
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

// Mirror main() minus throttle: split --event, render, emit with the injected stdin.
const runHookCli = async (argv: string[], stdinText: string): Promise<{ out: string }> => {
    const { event, positionals } = extractArgs(argv)
    const text = await renderTemplate(positionals, dir)
    let out = ""
    await runInjectionHook({
        event: event ?? "UserPromptSubmit",
        stdin: { text: () => Promise.resolve(stdinText) },
        write: (l) => {
            out = l
        },
        render: () => text
    })
    return { out }
}

describe("inject-trigger", () => {
    context("extracting --event, --every, and --first", () => {
        it("pulls --event, --every, and --first, keeping them out of the operands", () => {
            expect(
                extractArgs([
                    "triggers/NOTIFY_TRIGGER.md",
                    "--event",
                    "UserPromptSubmit",
                    "--every",
                    "1",
                    "--first",
                    "1"
                ])
            ).toEqual({
                event: "UserPromptSubmit",
                every: 1,
                first: 1,
                positionals: ["triggers/NOTIFY_TRIGGER.md"]
            })
        })
        it("supports Gemini's BeforeAgent event", () => {
            expect(extractArgs(["triggers/NOTIFY_TRIGGER.md", "--event", "BeforeAgent"]).event).toBe("BeforeAgent")
        })
        it("yields null for a dangling --event", () => {
            expect(extractArgs(["--event"])).toEqual({ event: null, every: null, first: null, positionals: [] })
        })
        it("treats a non-positive or non-numeric --every as absent (caller defaults)", () => {
            expect(extractArgs(["t.md", "--event", "X", "--every", "0"]).every).toBeNull()
            expect(extractArgs(["t.md", "--event", "X", "--every", "nope"]).every).toBeNull()
        })
        it("treats a non-positive or non-numeric --first as absent (caller defaults)", () => {
            expect(extractArgs(["t.md", "--event", "X", "--first", "0"]).first).toBeNull()
            expect(extractArgs(["t.md", "--event", "X", "--first", "nope"]).first).toBeNull()
        })
    })

    context("rendering the template into the envelope", () => {
        it("injects the stripped template as additionalContext", async () => {
            const template = await writeTmp("# Trigger: X\n\nbody\n")
            const { out } = await runHookCli([template, "--event", "UserPromptSubmit"], "{}")
            const parsed = JSON.parse(out)
            expect(parsed.hookSpecificOutput.additionalContext).toBe("# Trigger: X\n\nbody")
            expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
        })

        it("lets a stdin hook_event_name win over --event", async () => {
            const template = await writeTmp("body\n")
            const { out } = await runHookCli(
                [template, "--event", "BeforeAgent"],
                '{"hook_event_name":"UserPromptSubmit"}'
            )
            expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
        })

        it("is a {} no-op for a missing template", async () => {
            const { out } = await runHookCli(["/nonexistent/____.md"], "{}")
            expect(out).toBe("{}")
        })

        it("is a {} no-op when no template arg is given", async () => {
            const { out } = await runHookCli(["--event", "UserPromptSubmit"], "{}")
            expect(out).toBe("{}")
        })
    })

    context("cadence gating through the shared throttle", () => {
        let restore: PropertyDescriptor | undefined
        let stateDir = ""
        beforeEach(async () => {
            stateDir = await mkdtemp(join(tmpdir(), "preemdeck-injtrig-state-"))
            restore = Object.getOwnPropertyDescriptor(ENV, "PREEMDECK_ROOT")
            Object.defineProperty(ENV, "PREEMDECK_ROOT", { configurable: true, get: () => stateDir })
        })
        afterEach(async () => {
            if (restore) Object.defineProperty(ENV, "PREEMDECK_ROOT", restore)
            await rm(stateDir, { recursive: true, force: true })
        })

        // Compose render exactly as main() does, so throttle actually gates the inject.
        const runGated = async (
            text: string | null,
            every: number,
            first: number,
            sessionId: string
        ): Promise<string> => {
            let out = ""
            await runInjectionHook({
                event: "UserPromptSubmit",
                stdin: { text: () => Promise.resolve(JSON.stringify({ session_id: sessionId })) },
                write: (l) => {
                    out = l
                },
                render: (payload) => (text && throttle(payload, every, first) ? text : null)
            })
            return out
        }

        it("injects every turn with --every 1 --first 1", async () => {
            expect(await runGated("directive", 1, 1, "e")).not.toBe("{}")
            expect(await runGated("directive", 1, 1, "e")).not.toBe("{}")
        })

        it("holds off until turn `first`, then fires on the cadence boundary", async () => {
            expect(await runGated("directive", 5, 3, "s")).toBe("{}") // turn 1, before first
            expect(await runGated("directive", 5, 3, "s")).toBe("{}") // turn 2, before first
            expect(await runGated("directive", 5, 3, "s")).not.toBe("{}") // turn 3 fires
        })

        it("stays a {} no-op on a cadence hit when the template is empty", async () => {
            expect(await runGated(null, 1, 1, "empty")).toBe("{}")
        })
    })
})
