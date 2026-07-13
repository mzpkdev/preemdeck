/**
 * inject-mode.spec.ts — config read via common/preemdeck (ENV.PREEMDECK_ROOT
 * override) + tmp skills dir; DI stdin/write for the envelope.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInjectionHook } from "../../../../common/hook-inject"
import { ENV } from "../../../../common/preemdeck"
import {
    DEFAULT_EVERY,
    extractEvent,
    extractEvery,
    extractFirst,
    loadModeText,
    renderBodies,
    renderGate,
    selectVariants
} from "./inject-mode"

const context = describe

let dir = ""
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "preemdeck-injmode-"))
})
afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

const writeCfg = async (text: string): Promise<void> => {
    await writeFile(join(dir, "preemdeck.json"), text)
}
const writeSkill = async (skillsDir: string, name: string, body: string) => {
    await mkdir(join(skillsDir, name), { recursive: true })
    await writeFile(join(skillsDir, name, "directive.md"), `${body}\n`)
}

describe("inject-mode", () => {
    context("selecting variants from the config", () => {
        it("reads slot values in order", () => {
            expect(selectVariants({ directive: { strategy: "swarm", discretion: "auto" } })).toEqual(["swarm", "auto"])
        })
        it("treats a bare string as a single value (legacy)", () => {
            expect(selectVariants({ directive: "swarm" })).toEqual(["swarm"])
        })
        it("is empty when directive is absent", () => {
            expect(selectVariants({})).toEqual([])
        })
        it("is empty for an empty directive object", () => {
            expect(selectVariants({ directive: {} })).toEqual([])
        })
        it("skips empty slots", () => {
            expect(selectVariants({ directive: { strategy: "swarm", discretion: "" } })).toEqual(["swarm"])
        })
        it("dedupes repeated values", () => {
            expect(selectVariants({ directive: { strategy: "swarm", discretion: "swarm" } })).toEqual(["swarm"])
        })
    })

    context("loading the mode text", () => {
        it("loads the directive body (trimmed)", async () => {
            await writeSkill(dir, "swarm", "swarm body")
            expect(await loadModeText(dir, "swarm")).toBe("swarm body")
        })
        it("is null for an unknown mode", async () => {
            expect(await loadModeText(dir, "nope")).toBeNull()
        })
        it("is null for an empty body", async () => {
            await writeSkill(dir, "blank", "   ")
            expect(await loadModeText(dir, "blank")).toBeNull()
        })
        it("rejects path traversal", async () => {
            await mkdir(join(dir, "secret"))
            await writeFile(join(dir, "secret", "directive.md"), "secret")
            expect(await loadModeText(join(dir, "skills"), "../secret")).toBeNull()
        })
    })

    context("extracting the event flag", () => {
        it("returns the value after the first --event", () => {
            expect(extractEvent(["--event", "BeforeAgent", "x"])).toBe("BeforeAgent")
        })
        it("accepts the inline --event=<value> form", () => {
            expect(extractEvent(["--event=BeforeAgent"])).toBe("BeforeAgent")
        })
        it("is null when absent or dangling", () => {
            expect(extractEvent(["x", "y"])).toBeNull()
            expect(extractEvent(["--event"])).toBeNull()
        })
    })

    context("extracting the every flag", () => {
        it("returns the value after the first --every", () => {
            expect(extractEvery(["--every", "5", "x"])).toBe(5)
        })
        it("accepts the inline --every=<n> form", () => {
            expect(extractEvery(["--every=3"])).toBe(3)
        })
        it("is null when absent, dangling, or non-positive (caller falls back to DEFAULT_EVERY)", () => {
            expect(extractEvery(["x"])).toBeNull()
            expect(extractEvery(["--every"])).toBeNull()
            expect(extractEvery(["--every", "0"])).toBeNull()
            expect(extractEvery(["--every", "abc"])).toBeNull()
        })
    })

    context("extracting the first flag", () => {
        it("returns the value after the first --first", () => {
            expect(extractFirst(["--first", "3", "x"])).toBe(3)
        })
        it("accepts the inline --first=<n> form", () => {
            expect(extractFirst(["--first=2"])).toBe(2)
        })
        it("is null when absent, dangling, or non-positive (caller falls back to DEFAULT_FIRST)", () => {
            expect(extractFirst(["x"])).toBeNull()
            expect(extractFirst(["--first"])).toBeNull()
            expect(extractFirst(["--first", "0"])).toBeNull()
            expect(extractFirst(["--first", "abc"])).toBeNull()
        })
    })

    context("running the main pipeline (renderBodies + envelope)", () => {
        // renderBodies reads preemdeck.json from ENV.PREEMDECK_ROOT; point it at the fixture dir.
        let skillsDir = ""
        let restore: PropertyDescriptor | undefined
        beforeEach(() => {
            skillsDir = join(dir, "skills")
            restore = Object.getOwnPropertyDescriptor(ENV, "PREEMDECK_ROOT")
            Object.defineProperty(ENV, "PREEMDECK_ROOT", { configurable: true, get: () => dir })
        })
        afterEach(() => {
            if (restore) Object.defineProperty(ENV, "PREEMDECK_ROOT", restore)
        })
        async function emit(opts: { stdin?: string; event?: string; every?: number } = {}): Promise<string> {
            const cliEvent = opts.event ?? "UserPromptSubmit"
            const every = opts.every ?? DEFAULT_EVERY
            let out = ""
            const bodies = await renderBodies(skillsDir)
            await runInjectionHook({
                event: cliEvent,
                stdin: { text: () => Promise.resolve(opts.stdin ?? "{}") },
                write: (l) => {
                    out = l
                },
                render: renderGate(bodies, every)
            })
            return out
        }

        it("is a no-op when there is no config", async () => {
            await mkdir(skillsDir, { recursive: true })
            expect(await emit()).toBe("{}")
        })

        it("is a no-op when the config is malformed", async () => {
            await mkdir(skillsDir, { recursive: true })
            await writeCfg("{bad json")
            await writeSkill(skillsDir, "swarm", "swarm body")
            expect(await emit()).toBe("{}")
        })

        it("is a no-op when directive is the wrong type", async () => {
            await mkdir(skillsDir, { recursive: true })
            await writeCfg('{"directive":42}')
            await writeSkill(skillsDir, "swarm", "swarm body")
            expect(await emit()).toBe("{}")
        })

        it("concatenates slots in order", async () => {
            await writeCfg('{"directive":{"strategy":"swarm","discretion":"auto"}}')
            await writeSkill(skillsDir, "swarm", "swarm body")
            await writeSkill(skillsDir, "auto", "auto body")
            await writeSkill(skillsDir, "ask", "ask body")
            expect(JSON.parse(await emit()).hookSpecificOutput.additionalContext).toBe("swarm body\n\nauto body")
        })

        it("routes a single value from a bare string", async () => {
            await writeCfg('{"directive":"swarm"}')
            await writeSkill(skillsDir, "swarm", "swarm body")
            await writeSkill(skillsDir, "auto", "auto body")
            expect(JSON.parse(await emit()).hookSpecificOutput.additionalContext).toBe("swarm body")
        })

        it("skips an unknown value", async () => {
            await writeCfg('{"directive":{"strategy":"swarm","discretion":"nope"}}')
            await writeSkill(skillsDir, "swarm", "swarm body")
            expect(JSON.parse(await emit()).hookSpecificOutput.additionalContext).toBe("swarm body")
        })

        it("is a no-op when all values are unknown", async () => {
            await writeCfg('{"directive":{"strategy":"nope"}}')
            await writeSkill(skillsDir, "swarm", "swarm body")
            expect(await emit()).toBe("{}")
        })

        it("is a no-op for an empty object", async () => {
            await writeCfg('{"directive":{}}')
            await writeSkill(skillsDir, "swarm", "swarm body")
            expect(await emit()).toBe("{}")
        })

        it("falls back to the --event flag", async () => {
            await writeCfg('{"directive":{"strategy":"swarm"}}')
            await writeSkill(skillsDir, "swarm", "swarm body")
            expect(JSON.parse(await emit({ event: "BeforeAgent" })).hookSpecificOutput.hookEventName).toBe(
                "BeforeAgent"
            )
        })

        it("overrides the flag with a stdin event", async () => {
            await writeCfg('{"directive":{"strategy":"swarm"}}')
            await writeSkill(skillsDir, "swarm", "swarm body")
            const out = await emit({ stdin: '{"hook_event_name":"FromStdin"}', event: "BeforeAgent" })
            expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("FromStdin")
        })

        it("injects on the 1st prompt of a session (throttle cadence)", async () => {
            await writeCfg('{"directive":{"strategy":"swarm"}}')
            await writeSkill(skillsDir, "swarm", "swarm body")
            const out = await emit({ stdin: JSON.stringify({ session_id: "s" }), every: 5 })
            expect(JSON.parse(out).hookSpecificOutput.additionalContext).toBe("swarm body")
        })

        it("is a no-op on an off-cadence prompt (2nd with every=5)", async () => {
            await writeCfg('{"directive":{"strategy":"swarm"}}')
            await writeSkill(skillsDir, "swarm", "swarm body")
            await emit({ stdin: JSON.stringify({ session_id: "s" }), every: 5 }) // 1st turn
            const out = await emit({ stdin: JSON.stringify({ session_id: "s" }), every: 5 }) // 2nd turn
            expect(out).toBe("{}")
        })

        it("injects again on the cadence boundary (6th with every=5)", async () => {
            await writeCfg('{"directive":{"strategy":"swarm"}}')
            await writeSkill(skillsDir, "swarm", "swarm body")
            let out = ""
            for (let i = 0; i < 6; i++) out = await emit({ stdin: JSON.stringify({ session_id: "s" }), every: 5 })
            expect(JSON.parse(out).hookSpecificOutput.additionalContext).toBe("swarm body") // 6th fires
        })
    })
})
