import { describe, expect, it } from "bun:test"
import { runInjectionHook } from "./hook-inject.ts"

const context = describe

const fakeStdin = (text: string) => ({ text: () => Promise.resolve(text) })

describe("runInjectionHook", () => {
    context("resolving the event name", () => {
        it("emits a JSON envelope carrying the event and raw render text", async () => {
            let out = ""
            await runInjectionHook({
                event: "UserPromptSubmit",
                stdin: fakeStdin('{"hook_event_name":"UserPromptSubmit"}'),
                write: (l) => {
                    out = l
                },
                render: () => "café — ok"
            })
            const parsed = JSON.parse(out)
            expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
            expect(parsed.hookSpecificOutput.additionalContext).toBe("café — ok")
        })

        it("lets the stdin hook_event_name win over the event option", async () => {
            let out = ""
            await runInjectionHook({
                event: "SessionStart",
                stdin: fakeStdin('{"hook_event_name":"BeforeAgent"}'),
                write: (l) => {
                    out = l
                },
                render: () => "x"
            })
            expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("BeforeAgent")
        })

        it("uses the event option when stdin omits hook_event_name", async () => {
            let out = ""
            await runInjectionHook({
                event: "SessionStart",
                stdin: fakeStdin("{}"),
                write: (l) => (out = l),
                render: () => "x"
            })
            expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("SessionStart")
        })
    })

    context("on unusable stdin", () => {
        it("falls back to a {} payload but still runs render", async () => {
            const seen: unknown[] = []
            const capture = (p: Record<string, unknown>): null => {
                seen.push(p)
                return null
            }
            await runInjectionHook({
                event: "UserPromptSubmit",
                stdin: fakeStdin(""),
                write: () => {},
                render: capture
            })
            await runInjectionHook({
                event: "UserPromptSubmit",
                stdin: fakeStdin("}{"),
                write: () => {},
                render: capture
            })
            await runInjectionHook({
                event: "UserPromptSubmit",
                stdin: fakeStdin("[1,2]"),
                write: () => {},
                render: capture
            })
            expect(seen).toEqual([{}, {}, {}])
        })
    })

    context("when render produces nothing", () => {
        it("emits exactly {} for a null or empty render", async () => {
            let out = ""
            await runInjectionHook({
                event: "UserPromptSubmit",
                stdin: fakeStdin("{}"),
                write: (l) => (out = l),
                render: () => null
            })
            expect(out).toBe("{}")
            await runInjectionHook({
                event: "UserPromptSubmit",
                stdin: fakeStdin("{}"),
                write: (l) => (out = l),
                render: () => ""
            })
            expect(out).toBe("{}")
        })

        it("treats a throwing render as a no-op", async () => {
            let out = ""
            await runInjectionHook({
                event: "UserPromptSubmit",
                stdin: fakeStdin("{}"),
                write: (l) => (out = l),
                render: () => {
                    throw new Error("boom")
                }
            })
            expect(out).toBe("{}")
        })
    })
})
