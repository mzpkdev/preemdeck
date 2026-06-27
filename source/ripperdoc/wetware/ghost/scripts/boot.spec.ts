/**
 * boot.spec.ts — Tmp-fixture FS for readSource/combinedPersona;
 * DI stdin/write for the envelope.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInjectionHook } from "../../../../common/hook-inject.ts"
import { combinedPersona, readSource } from "./boot.ts"

const context = describe

let dir = ""
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "preemdeck-boot-"))
})
afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")

describe("boot", () => {
    context("reading the persona source", () => {
        it("returns null when both missing", async () => {
            expect(await readSource(dir, "engram.dat", "ENGRAM.md")).toBeNull()
        })

        it("reads the .dat (base64) over the .md", async () => {
            await writeFile(join(dir, "engram.dat"), b64("hello from dat"))
            await writeFile(join(dir, "ENGRAM.md"), "hello from md")
            expect(await readSource(dir, "engram.dat", "ENGRAM.md")).toBe("hello from dat")
        })

        it("reads the .md when the .dat is missing", async () => {
            await writeFile(join(dir, "ENGRAM.md"), "engram content")
            expect(await readSource(dir, "engram.dat", "ENGRAM.md")).toBe("engram content")
        })

        it("decodes base64 .dat content", async () => {
            await writeFile(join(dir, "engram.dat"), b64("persona data here"))
            expect(await readSource(dir, "engram.dat", "ENGRAM.md")).toBe("persona data here")
        })
    })

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
