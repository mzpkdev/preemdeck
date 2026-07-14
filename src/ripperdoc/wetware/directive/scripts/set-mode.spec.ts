/**
 * set-mode.spec.ts — Tmp-fixture FS; the exit-code path is exercised through
 * main() (which returns the code rather than exiting). stderr is captured by
 * spying process.stderr.write.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { glob, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { availableModes, clearDirective, configSlots, ModesError, main, setDirective, slotFor } from "./set-mode"

const context = describe

let dir = ""
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "preemdeck-setmode-"))
})
afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

const writeSkill = async (skillsDir: string, name: string) => {
    await mkdir(join(skillsDir, name), { recursive: true })
    await writeFile(join(skillsDir, name, "directive.md"), "body\n")
}
const captureStderr = (): { restore: () => void; text: () => string } => {
    let buf = ""
    const spy = spyOn(process.stderr, "write").mockImplementation(((c: string) => {
        buf += c
        return true
    }) as never)
    return { restore: () => spy.mockRestore(), text: () => buf }
}

describe("set-mode", () => {
    context("listing available modes", () => {
        it("lists skill folders that ship a directive.md (sorted)", async () => {
            const d = join(dir, "skills")
            for (const n of ["swarm", "ask"]) await writeSkill(d, n)
            expect(await availableModes(d)).toEqual(["ask", "swarm"])
        })
        it("is empty when the dir is missing", async () => {
            expect(await availableModes(join(dir, "nope"))).toEqual([])
        })
        it("ignores dirs without a directive.md", async () => {
            const d = join(dir, "skills")
            await writeSkill(d, "swarm")
            await mkdir(join(d, "default"))
            expect(await availableModes(d)).toEqual(["swarm"])
        })
    })

    context("resolving a slot from modes.json", () => {
        async function modes(map: Record<string, unknown>): Promise<string> {
            const p = join(dir, "modes.json")
            await writeFile(p, JSON.stringify(map))
            return p
        }
        it("reads the slot from modes.json", async () => {
            const m = await modes({ swarm: "strategy", ask: "discretion" })
            expect(await slotFor(m, "swarm")).toBe("strategy")
            expect(await slotFor(m, "ask")).toBe("discretion")
        })
        it("is null when the value is absent", async () => {
            expect(await slotFor(await modes({ ask: "discretion" }), "swarm")).toBeNull()
        })
        it("is null when the slot is blank", async () => {
            expect(await slotFor(await modes({ swarm: "   " }), "swarm")).toBeNull()
        })
        it("throws when modes.json is missing", async () => {
            await expect(slotFor(join(dir, "nope.json"), "swarm")).rejects.toThrow(ModesError)
        })
        it("throws when modes.json is malformed", async () => {
            const p = join(dir, "modes.json")
            await writeFile(p, "{bad")
            await expect(slotFor(p, "swarm")).rejects.toThrow(ModesError)
        })
    })

    context("reading the config slots", () => {
        async function cfg(text: string): Promise<string> {
            const p = join(dir, "preemdeck.json")
            await writeFile(p, text)
            return p
        }
        it("lists the directive object keys (insertion order)", async () => {
            expect(await configSlots(await cfg('{"directive":{"strategy":"x","discretion":"y"}}'))).toEqual([
                "strategy",
                "discretion"
            ])
        })
        it("is empty when missing", async () => {
            expect(await configSlots(await cfg('{"other":1}'))).toEqual([])
        })
        it("is empty for the legacy string form", async () => {
            expect(await configSlots(await cfg('{"directive":"swarm"}'))).toEqual([])
        })
        it("is empty when malformed", async () => {
            expect(await configSlots(await cfg("{bad"))).toEqual([])
        })
    })

    context("writing the directive", () => {
        async function cfg(text: string): Promise<string> {
            const p = join(dir, "preemdeck.json")
            await writeFile(p, text)
            return p
        }
        it("sets the slot and preserves the others + top-level keys", async () => {
            const p = await cfg('{\n  "directive": {"strategy": "", "discretion": "ask"},\n  "other": 1\n}\n')
            await setDirective(p, "strategy", "swarm")
            expect(JSON.parse(await readFile(p, "utf8"))).toEqual({
                directive: { strategy: "swarm", discretion: "ask" },
                other: 1
            })
        })
        it("creates the object when missing", async () => {
            const p = await cfg('{"keep":true}')
            await setDirective(p, "strategy", "swarm")
            expect(JSON.parse(await readFile(p, "utf8"))).toEqual({ keep: true, directive: { strategy: "swarm" } })
        })
        it("adds a new slot preserving the existing", async () => {
            const p = await cfg('{"directive":{"strategy":"swarm"}}')
            await setDirective(p, "discretion", "auto")
            expect(JSON.parse(await readFile(p, "utf8"))).toEqual({
                directive: { strategy: "swarm", discretion: "auto" }
            })
        })
        it("uses fixed 2-space framing with a trailing newline", async () => {
            const p = await cfg("{}")
            await setDirective(p, "strategy", "swarm")
            expect(await readFile(p, "utf8")).toBe('{\n  "directive": {\n    "strategy": "swarm"\n  }\n}\n')
        })
        it("rewrites idempotently", async () => {
            const p = await cfg('{"directive":{"strategy":"swarm"}}')
            await setDirective(p, "strategy", "swarm")
            const first = await readFile(p, "utf8")
            await setDirective(p, "strategy", "swarm")
            expect(await readFile(p, "utf8")).toBe(first)
        })
        it("leaves no .tmp behind", async () => {
            const p = await cfg("{}")
            await setDirective(p, "strategy", "swarm")
            const leftovers: string[] = []
            for await (const f of glob("*.tmp", { cwd: dir })) leftovers.push(f)
            expect(leftovers).toEqual([])
        })
    })

    context("clearing the directive (none)", () => {
        async function cfg(text: string): Promise<string> {
            const p = join(dir, "preemdeck.json")
            await writeFile(p, text)
            return p
        }
        it("empties every slot, preserving keys + top-level keys", async () => {
            const p = await cfg('{"directive":{"strategy":"swarm","discretion":"ask"},"other":1}')
            expect(await clearDirective(p)).toEqual(["strategy", "discretion"])
            expect(JSON.parse(await readFile(p, "utf8"))).toEqual({
                directive: { strategy: "", discretion: "" },
                other: 1
            })
        })
        it("is a no-op (empty directive) when there is none", async () => {
            const p = await cfg('{"keep":true}')
            expect(await clearDirective(p)).toEqual([])
            expect(JSON.parse(await readFile(p, "utf8"))).toEqual({ keep: true, directive: {} })
        })
    })

    context("when run via main", () => {
        async function setup(
            opts: { configText?: string | null } = {}
        ): Promise<{ cfg: string; skills: string; modes: string }> {
            const skills = join(dir, "skills")
            for (const n of ["swarm", "ask", "auto"]) await writeSkill(skills, n)
            const modes = join(dir, "modes.json")
            await writeFile(modes, JSON.stringify({ swarm: "strategy", ask: "discretion", auto: "discretion" }))
            const cfg = join(dir, "preemdeck.json")
            const text =
                opts.configText === undefined ? '{"directive": {"strategy": "", "discretion": ""}}' : opts.configText
            if (text !== null) await writeFile(cfg, text)
            return { cfg, skills, modes }
        }
        const opts = (s: { cfg: string; skills: string; modes: string }) => ({
            searchStart: dir,
            skillsDir: s.skills,
            modesFile: s.modes
        })

        it("derives the strategy slot from a value", async () => {
            const s = await setup()
            expect(await main(["swarm"], opts(s))).toBe(0)
            expect(JSON.parse(await readFile(s.cfg, "utf8")).directive).toEqual({ strategy: "swarm", discretion: "" })
        })
        it("derives the discretion slot from a value", async () => {
            const s = await setup()
            expect(await main(["ask"], opts(s))).toBe(0)
            expect(JSON.parse(await readFile(s.cfg, "utf8")).directive).toEqual({ strategy: "", discretion: "ask" })
        })
        it("preserves the other slot + top-level keys", async () => {
            const s = await setup({ configText: '{"directive": {"strategy": "swarm", "discretion": ""}, "other": 1}' })
            expect(await main(["auto"], opts(s))).toBe(0)
            expect(JSON.parse(await readFile(s.cfg, "utf8"))).toEqual({
                directive: { strategy: "swarm", discretion: "auto" },
                other: 1
            })
        })
        it("rewrites idempotently", async () => {
            const s = await setup()
            expect(await main(["swarm"], opts(s))).toBe(0)
            const first = await readFile(s.cfg, "utf8")
            expect(await main(["swarm"], opts(s))).toBe(0)
            expect(await readFile(s.cfg, "utf8")).toBe(first)
        })
        it("clears every slot with the none sentinel", async () => {
            const s = await setup({
                configText: '{"directive": {"strategy": "swarm", "discretion": "ask"}, "other": 1}'
            })
            expect(await main(["none"], opts(s))).toBe(0)
            expect(JSON.parse(await readFile(s.cfg, "utf8"))).toEqual({
                directive: { strategy: "", discretion: "" },
                other: 1
            })
        })
        it("none exits 2 when the config is missing", async () => {
            const s = await setup({ configText: null })
            const err = captureStderr()
            try {
                expect(await main(["none"], opts(s))).toBe(2)
                expect(err.text()).toContain("not found")
            } finally {
                err.restore()
            }
        })
        it("exits 2 without writing on an unknown value", async () => {
            const s = await setup()
            const err = captureStderr()
            try {
                expect(await main(["bogus"], opts(s))).toBe(2)
                expect(err.text()).toContain("value")
            } finally {
                err.restore()
            }
            expect(JSON.parse(await readFile(s.cfg, "utf8")).directive).toEqual({ strategy: "", discretion: "" })
        })
        it("exits 2 without writing when a valid mode is missing from modes.json", async () => {
            const s = await setup()
            await writeFile(s.modes, JSON.stringify({ ask: "discretion", auto: "discretion" }))
            const err = captureStderr()
            try {
                expect(await main(["swarm"], opts(s))).toBe(2)
                expect(err.text()).toContain("slot")
            } finally {
                err.restore()
            }
        })
        it("exits 2 without writing when modes.json is missing", async () => {
            const s = await setup()
            await rm(s.modes)
            const err = captureStderr()
            try {
                expect(await main(["swarm"], opts(s))).toBe(2)
                expect(err.text()).toContain("modes.json")
            } finally {
                err.restore()
            }
        })
        it("exits 2 without writing when modes.json is malformed", async () => {
            const s = await setup()
            await writeFile(s.modes, "{bad")
            const err = captureStderr()
            try {
                expect(await main(["swarm"], opts(s))).toBe(2)
                expect(err.text()).toContain("modes.json")
            } finally {
                err.restore()
            }
        })
        it("exits 2 when the derived slot is absent from config", async () => {
            const s = await setup({ configText: '{"directive": {"discretion": ""}}' })
            const err = captureStderr()
            try {
                expect(await main(["swarm"], opts(s))).toBe(2)
                expect(err.text()).toContain("slot")
            } finally {
                err.restore()
            }
            expect(JSON.parse(await readFile(s.cfg, "utf8")).directive.strategy).toBeUndefined()
        })
        it("exits 2 on the wrong arg count", async () => {
            const s = await setup()
            const err = captureStderr()
            try {
                expect(await main([], opts(s))).toBe(2)
                expect(await main(["swarm", "extra"], opts(s))).toBe(2)
            } finally {
                err.restore()
            }
        })
        it("exits 2 on a blank arg", async () => {
            const s = await setup()
            const err = captureStderr()
            try {
                expect(await main(["   "], opts(s))).toBe(2)
            } finally {
                err.restore()
            }
        })
        it("exits 2 when the config is missing", async () => {
            const s = await setup({ configText: null })
            const err = captureStderr()
            try {
                expect(await main(["swarm"], opts(s))).toBe(2)
                expect(err.text()).toContain("not found")
            } finally {
                err.restore()
            }
        })
    })
})
