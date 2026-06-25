/**
 * pulse.test.ts — Tmp-fixture FS + DI stdin/write.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInjectionHook } from "../../../../lib/inject.ts"
import { readSource } from "./pulse.ts"

let dir = ""
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "preemdeck-pulse-"))
})
afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")

describe("readSource", () => {
    test("returns null when both missing", async () => {
        expect(await readSource(dir, "pulse.dat", "PULSE.md")).toBeNull()
    })

    test("reads the .dat over the .md", async () => {
        await writeFile(join(dir, "pulse.dat"), b64("dat content"))
        await writeFile(join(dir, "PULSE.md"), "md content")
        expect(await readSource(dir, "pulse.dat", "PULSE.md")).toBe("dat content")
    })

    test("reads the .md when the .dat is absent", async () => {
        await writeFile(join(dir, "PULSE.md"), "pulse persona")
        expect(await readSource(dir, "pulse.dat", "PULSE.md")).toBe("pulse persona")
    })

    test("decodes multi-line base64 correctly", async () => {
        await writeFile(join(dir, "pulse.dat"), b64("multi\nline\ncontent"))
        expect(await readSource(dir, "pulse.dat", "PULSE.md")).toBe("multi\nline\ncontent")
    })
})

describe("pulse envelope", () => {
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

    test("emits {} when there is no content", async () => {
        expect(await emit("{}")).toBe("{}")
    })

    test("emits the body when content exists", async () => {
        await writeFile(join(dir, "PULSE.md"), "pulse persona content")
        expect(JSON.parse(await emit("{}")).hookSpecificOutput.additionalContext).toContain("pulse persona content")
    })

    test("strips surrounding whitespace from the body", async () => {
        await writeFile(join(dir, "PULSE.md"), "  content with spaces  \n")
        expect(JSON.parse(await emit("{}")).hookSpecificOutput.additionalContext).toBe("content with spaces")
    })

    test("default event is UserPromptSubmit", async () => {
        await writeFile(join(dir, "PULSE.md"), "content")
        expect(JSON.parse(await emit("{}")).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
    })

    test("a string hook_event_name from stdin wins", async () => {
        await writeFile(join(dir, "PULSE.md"), "content")
        expect(JSON.parse(await emit('{"hook_event_name":"MyEvent"}')).hookSpecificOutput.hookEventName).toBe("MyEvent")
    })

    test("invalid stdin falls back to the default event", async () => {
        await writeFile(join(dir, "PULSE.md"), "content")
        expect(JSON.parse(await emit("{bad json}")).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
    })

    test("a null hook_event_name is ignored", async () => {
        await writeFile(join(dir, "PULSE.md"), "content")
        expect(JSON.parse(await emit('{"hook_event_name":null}')).hookSpecificOutput.hookEventName).toBe(
            "UserPromptSubmit"
        )
    })
})
