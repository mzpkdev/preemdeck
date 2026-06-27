/**
 * pulse.spec.ts — Tmp-fixture FS + DI stdin/write.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInjectionHook } from "../../../../common/hook-inject.ts"
import { readSource } from "./pulse.ts"

const context = describe

let dir = ""
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "preemdeck-pulse-"))
})
afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")

describe("pulse", () => {
    context("reading the persona source", () => {
        it("returns null when both missing", async () => {
            expect(await readSource(dir, "pulse.dat", "PULSE.md")).toBeNull()
        })

        it("reads the .dat over the .md", async () => {
            await writeFile(join(dir, "pulse.dat"), b64("dat content"))
            await writeFile(join(dir, "PULSE.md"), "md content")
            expect(await readSource(dir, "pulse.dat", "PULSE.md")).toBe("dat content")
        })

        it("reads the .md when the .dat is absent", async () => {
            await writeFile(join(dir, "PULSE.md"), "pulse persona")
            expect(await readSource(dir, "pulse.dat", "PULSE.md")).toBe("pulse persona")
        })

        it("decodes multi-line base64 correctly", async () => {
            await writeFile(join(dir, "pulse.dat"), b64("multi\nline\ncontent"))
            expect(await readSource(dir, "pulse.dat", "PULSE.md")).toBe("multi\nline\ncontent")
        })
    })

    context("emitting the envelope", () => {
        async function emit(stdinText: string): Promise<string> {
            let out = ""
            const content = await readSource(dir, "pulse.dat", "PULSE.md")
            await runInjectionHook({
                event: "UserPromptSubmit",
                stdin: { text: () => Promise.resolve(stdinText) },
                write: (l) => {
                    out = l
                },
                render: () => {
                    return content ? content.trim() : null
                }
            })
            return out
        }

        it("emits {} when there is no content", async () => {
            expect(await emit("{}")).toBe("{}")
        })

        it("emits the body when content exists", async () => {
            await writeFile(join(dir, "PULSE.md"), "pulse persona content")
            expect(JSON.parse(await emit("{}")).hookSpecificOutput.additionalContext).toContain("pulse persona content")
        })

        it("strips surrounding whitespace from the body", async () => {
            await writeFile(join(dir, "PULSE.md"), "  content with spaces  \n")
            expect(JSON.parse(await emit("{}")).hookSpecificOutput.additionalContext).toBe("content with spaces")
        })

        it("defaults the event to UserPromptSubmit", async () => {
            await writeFile(join(dir, "PULSE.md"), "content")
            expect(JSON.parse(await emit("{}")).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
        })

        it("lets a string hook_event_name from stdin win", async () => {
            await writeFile(join(dir, "PULSE.md"), "content")
            expect(JSON.parse(await emit('{"hook_event_name":"MyEvent"}')).hookSpecificOutput.hookEventName).toBe(
                "MyEvent"
            )
        })

        it("falls back to the default event on invalid stdin", async () => {
            await writeFile(join(dir, "PULSE.md"), "content")
            expect(JSON.parse(await emit("{bad json}")).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
        })

        it("ignores a null hook_event_name", async () => {
            await writeFile(join(dir, "PULSE.md"), "content")
            expect(JSON.parse(await emit('{"hook_event_name":null}')).hookSpecificOutput.hookEventName).toBe(
                "UserPromptSubmit"
            )
        })
    })
})
