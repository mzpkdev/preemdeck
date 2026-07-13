/**
 * inject-tab-name.spec.ts — the tab-naming directive injector.
 *
 * Tmp-fixture FS for templates; DI stdin/write for the envelope (mirrors
 * inject-hook.spec). Tests pass absolute temp paths, which resolve() honors
 * verbatim, so the explicit `pluginRoot` is irrelevant to what gets read — it just
 * avoids evaluating the real ENV.PLUGIN_ROOT default. The throttle-gating context
 * redirects ENV.PREEMDECK_ROOT (where throttle persists counters) at a temp dir and
 * composes render exactly as main() does (text && throttle -> text).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInjectionHook } from "../../../../common/hook-inject"
import { throttle } from "../../../../common/hooks"
import { ENV } from "../../../../common/preemdeck"
import { appendTabName, type CurrentTabNameDeps, currentTabName, extractArgs, renderTemplate } from "./inject-tab-name"

const context = describe

let dir = ""
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "preemdeck-injtab-"))
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

describe("inject-tab-name", () => {
    context("extracting --event, --every, and --first", () => {
        it("pulls --event, --every, and --first, keeping them out of the operands", () => {
            expect(
                extractArgs([
                    "triggers/RENAME_TAB_TRIGGER.md",
                    "--event",
                    "UserPromptSubmit",
                    "--every",
                    "3",
                    "--first",
                    "1"
                ])
            ).toEqual({
                event: "UserPromptSubmit",
                every: 3,
                first: 1,
                positionals: ["triggers/RENAME_TAB_TRIGGER.md"]
            })
        })
        it("supports Gemini's BeforeAgent event", () => {
            expect(extractArgs(["triggers/RENAME_TAB_TRIGGER.md", "--event", "BeforeAgent"]).event).toBe("BeforeAgent")
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
            const template = await writeTmp("# TAB\n\npick a slug and rename\n")
            const { out } = await runHookCli([template, "--event", "UserPromptSubmit"], "{}")
            const parsed = JSON.parse(out)
            expect(parsed.hookSpecificOutput.additionalContext).toBe("# TAB\n\npick a slug and rename")
            expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
        })

        it("supplies the fallback event from --event", async () => {
            const template = await writeTmp("body\n")
            const { out } = await runHookCli([template, "--event", "BeforeAgent"], "{}")
            expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("BeforeAgent")
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

        it("is a {} no-op for a whitespace-only template", async () => {
            const template = await writeTmp("   \n\t\n")
            const { out } = await runHookCli([template], "{}")
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
            stateDir = await mkdtemp(join(tmpdir(), "preemdeck-injtab-state-"))
            restore = Object.getOwnPropertyDescriptor(ENV, "PREEMDECK_ROOT")
            Object.defineProperty(ENV, "PREEMDECK_ROOT", { configurable: true, get: () => stateDir })
        })
        afterEach(async () => {
            if (restore) Object.defineProperty(ENV, "PREEMDECK_ROOT", restore)
            await rm(stateDir, { recursive: true, force: true })
        })

        // Compose render exactly as main() does, so throttle actually gates the inject.
        const runGated = async (text: string | null, every: number, sessionId: string): Promise<string> => {
            let out = ""
            await runInjectionHook({
                event: "UserPromptSubmit",
                stdin: { text: () => Promise.resolve(JSON.stringify({ session_id: sessionId })) },
                write: (l) => {
                    out = l
                },
                render: (payload) => (text && throttle(payload, every) ? text : null)
            })
            return out
        }

        it("injects on turn 1 then no-ops until the next cadence boundary (--every 2)", async () => {
            expect(await runGated("directive", 2, "s")).not.toBe("{}") // turn 1 fires
            expect(await runGated("directive", 2, "s")).toBe("{}") // turn 2 skipped
            expect(await runGated("directive", 2, "s")).not.toBe("{}") // turn 3 fires
        })

        it("injects every turn with --every 1", async () => {
            expect(await runGated("directive", 1, "e")).not.toBe("{}")
            expect(await runGated("directive", 1, "e")).not.toBe("{}")
        })

        it("stays a {} no-op on a cadence hit when the template is empty", async () => {
            expect(await runGated(null, 1, "empty")).toBe("{}")
        })
    })

    context("appendTabName", () => {
        it("appends the current-name line to the directive", () => {
            expect(appendTabName("DIRECTIVE", "auth-retry")).toBe(
                "DIRECTIVE\n\nThis tab is currently named `auth-retry`."
            )
        })
        it("leaves the directive untouched for a null name", () => {
            expect(appendTabName("DIRECTIVE", null)).toBe("DIRECTIVE")
        })
    })

    context("currentTabName (read back from the IDE, glyph-stripped)", () => {
        const tabDeps = (
            over: { inIdea?: boolean; pids?: number[]; title?: string | null } = {}
        ): CurrentTabNameDeps => ({
            inIdea: () => over.inIdea ?? true,
            resolveTabPids: () => Promise.resolve(over.pids ?? [111]),
            readTabTitle: () => Promise.resolve(over.title ?? null)
        })

        it("strips our glyph off the read-back title", async () => {
            expect(await currentTabName(tabDeps({ title: "• tab-read-util" }))).toBe("tab-read-util")
        })
        it("preserves a glyph-less (IDE-menu / auto) name", async () => {
            expect(await currentTabName(tabDeps({ title: "hand-named" }))).toBe("hand-named")
        })
        it("is null outside a JetBrains terminal, never resolving pids", async () => {
            let pidReads = 0
            const deps: CurrentTabNameDeps = {
                ...tabDeps({ inIdea: false }),
                resolveTabPids: () => {
                    pidReads++
                    return Promise.resolve([1])
                }
            }
            expect(await currentTabName(deps)).toBeNull()
            expect(pidReads).toBe(0)
        })
        it("is null when no pid resolves", async () => {
            expect(await currentTabName(tabDeps({ pids: [] }))).toBeNull()
        })
        it("is null when the title can't be read", async () => {
            expect(await currentTabName(tabDeps({ title: null }))).toBeNull()
        })
        it("is null when the title strips to empty (a bare glyph)", async () => {
            expect(await currentTabName(tabDeps({ title: "◦" }))).toBeNull()
        })
        it("is null (never throws) when the read seam rejects", async () => {
            const deps: CurrentTabNameDeps = {
                ...tabDeps(),
                readTabTitle: () => Promise.reject(new Error("boom"))
            }
            expect(await currentTabName(deps)).toBeNull()
        })
    })
})
