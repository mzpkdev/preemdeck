/**
 * boot.spec.ts — combinedPersona over a tmp-fixture FS; DI stdin/write for the
 * envelope. (readSource lives in codec.spec.ts now.)
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInjectionHook } from "../../../../common/hook-inject"
import { combinedPersona } from "./boot"

const context = describe

let dir = ""
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "preemdeck-boot-"))
})
afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

describe("boot", () => {
    context("combining the persona + emitting the envelope", () => {
        // Helper: run the same render/emit pipeline main() uses, with injected stdin.
        async function emit(stdinText: string): Promise<string> {
            let out = ""
            const persona = await combinedPersona(dir)
            await runInjectionHook({
                event: "SessionStart",
                stdin: { text: () => Promise.resolve(stdinText) },
                write: (l) => {
                    out = l
                },
                render: () => persona || null
            })
            return out
        }

        it("emits {} when there is no content", async () => {
            expect(await emit("{}")).toBe("{}")
        })

        it("includes engram content", async () => {
            await writeFile(join(dir, "ENGRAM.md"), "engram content")
            expect(JSON.parse(await emit("{}")).hookSpecificOutput.additionalContext).toContain("engram content")
        })

        it("includes firmware content", async () => {
            await writeFile(join(dir, "FIRMWARE.md"), "firmware content")
            expect(JSON.parse(await emit("{}")).hookSpecificOutput.additionalContext).toContain("firmware content")
        })

        it("concatenates engram + firmware with a blank line", async () => {
            await writeFile(join(dir, "ENGRAM.md"), "  engram  ")
            await writeFile(join(dir, "FIRMWARE.md"), "  firmware  ")
            expect(await combinedPersona(dir)).toBe("engram\n\nfirmware")
        })

        it("defaults the event to SessionStart", async () => {
            await writeFile(join(dir, "ENGRAM.md"), "content")
            expect(JSON.parse(await emit("{}")).hookSpecificOutput.hookEventName).toBe("SessionStart")
        })

        it("lets a string hook_event_name from stdin win", async () => {
            await writeFile(join(dir, "ENGRAM.md"), "content")
            expect(JSON.parse(await emit('{"hook_event_name":"CustomEvent"}')).hookSpecificOutput.hookEventName).toBe(
                "CustomEvent"
            )
        })

        it("falls back to the default event on invalid stdin", async () => {
            await writeFile(join(dir, "ENGRAM.md"), "content")
            expect(JSON.parse(await emit("not json")).hookSpecificOutput.hookEventName).toBe("SessionStart")
        })

        it("falls back to the default on a non-string hook_event_name", async () => {
            await writeFile(join(dir, "ENGRAM.md"), "content")
            expect(JSON.parse(await emit('{"hook_event_name":42}')).hookSpecificOutput.hookEventName).toBe(
                "SessionStart"
            )
        })
    })
})
