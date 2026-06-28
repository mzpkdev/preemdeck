/**
 * inject-mode.spec.ts — Tmp-fixture FS for the config walk-up + skills dir;
 * DI stdin/write for the envelope.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInjectionHook } from "../../../../common/hook-inject"
import { extractEvent, findConfig, loadModeText, renderBodies, selectVariants } from "./inject-mode"

const context = describe

let dir = ""
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "preemdeck-injmode-"))
})
afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

const writeCfg = async (text: string): Promise<string> => {
    const p = join(dir, "preemdeck.json")
    await writeFile(p, text)
    return p
}
const writeSkill = async (skillsDir: string, name: string, body: string) => {
    await mkdir(join(skillsDir, name), { recursive: true })
    await writeFile(join(skillsDir, name, "directive.md"), `${body}\n`)
}

describe("inject-mode", () => {
    context("finding the config", () => {
        it("returns null when absent", async () => {
            expect(await findConfig(dir)).toBeNull()
        })
        it("finds it in the start dir", async () => {
            const cfg = await writeCfg("{}")
            expect(await findConfig(dir)).toBe(cfg)
        })
        it("walks up to an ancestor", async () => {
            const cfg = await writeCfg("{}")
            const nested = join(dir, "plugins", "cache", "directive", "scripts")
            await mkdir(nested, { recursive: true })
            expect(await findConfig(nested)).toBe(cfg)
        })
        it("lets the nearest ancestor win", async () => {
            await writeCfg('{"loc":"far"}')
            const nearDir = join(dir, "a", "b")
            await mkdir(nearDir, { recursive: true })
            const near = join(nearDir, "preemdeck.json")
            await writeFile(near, '{"loc":"near"}')
            expect(await findConfig(nearDir)).toBe(near)
        })
    })

    context("selecting variants from the config", () => {
        it("reads object values in slot order", async () => {
            expect(
                await selectVariants(await writeCfg('{"directive":{"strategy":"swarm","discretion":"auto"}}'))
            ).toEqual(["swarm", "auto"])
        })
        it("treats a bare string as a single value", async () => {
            expect(await selectVariants(await writeCfg('{"directive":"swarm"}'))).toEqual(["swarm"])
        })
        it("is empty when the field is missing", async () => {
            expect(await selectVariants(await writeCfg('{"other":"x"}'))).toEqual([])
        })
        it("is empty when malformed", async () => {
            expect(await selectVariants(await writeCfg("{bad json"))).toEqual([])
        })
        it("is empty when the field is the wrong type", async () => {
            expect(await selectVariants(await writeCfg('{"directive":42}'))).toEqual([])
        })
        it("yields nothing for an empty object", async () => {
            expect(await selectVariants(await writeCfg('{"directive":{}}'))).toEqual([])
        })
        it("filters blanks/non-strings and dedupes", async () => {
            expect(
                await selectVariants(await writeCfg('{"directive":{"a":"swarm","b":"","c":5,"d":"swarm"}}'))
            ).toEqual(["swarm"])
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
        it("is null when absent or dangling", () => {
            expect(extractEvent(["x", "y"])).toBeNull()
            expect(extractEvent(["--event"])).toBeNull()
        })
    })

    context("running the main pipeline (renderBodies + envelope)", () => {
        let skillsDir = ""
        beforeEach(() => {
            skillsDir = join(dir, "skills")
        })
        async function emit(opts: { stdin?: string; event?: string } = {}): Promise<string> {
            const cliEvent = opts.event ?? "UserPromptSubmit"
            let out = ""
            const bodies = await renderBodies(dir, skillsDir)
            await runInjectionHook({
                event: cliEvent,
                stdin: { text: () => Promise.resolve(opts.stdin ?? "{}") },
                write: (l) => {
                    out = l
                },
                render: () => bodies
            })
            return out
        }

        it("is a no-op when there is no config", async () => {
            await mkdir(skillsDir, { recursive: true })
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
    })
})
