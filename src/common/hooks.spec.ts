import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { throttle } from "./hooks"

let dir = ""
let counter = 0

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "preemdeck-hooks-"))
})
afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

const userRow = (content: unknown, extra: object = {}) =>
    JSON.stringify({ type: "user", message: { role: "user", content }, ...extra })
const toolResultRow = () =>
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "x" }] } })
const writeTranscript = async (...rows: string[]): Promise<string> => {
    const p = join(dir, `t${counter++}.jsonl`)
    await writeFile(p, `${rows.join("\n")}\n`)
    return p
}

describe("throttle (every-Nth user prompt, from the transcript)", () => {
    it("fires on prompts 1, N+1, 2N+1 as the transcript grows", async () => {
        const hits: boolean[] = []
        const prompts: string[] = []
        for (let i = 1; i <= 7; i++) {
            prompts.push(`p${i}`)
            const tp = await writeTranscript(...prompts.map((p) => userRow(p)))
            hits.push(throttle({ transcript_path: tp, prompt: `p${i}` }, 3)) // current already written
        }
        expect(hits).toEqual([true, false, false, true, false, false, true])
    })

    it("counts the current prompt even when it isn't flushed to the transcript yet", async () => {
        const empty = await writeTranscript() // first prompt, not yet written
        expect(throttle({ transcript_path: empty, prompt: "p1" }, 5)).toBe(true) // index 1
        const five = await writeTranscript(...["p1", "p2", "p3", "p4", "p5"].map((p) => userRow(p)))
        expect(throttle({ transcript_path: five, prompt: "p6" }, 5)).toBe(true) // unwritten 6th → index 6
    })

    it("counts real prompts only — tool results and subagent rows don't inflate the index", async () => {
        const tp = await writeTranscript(
            userRow("p1"),
            toolResultRow(),
            userRow("sub", { isSidechain: true }),
            toolResultRow()
        )
        expect(throttle({ transcript_path: tp, prompt: "p2" }, 5)).toBe(false) // one real prompt → index 2
    })

    it("fires every turn when N is 1", async () => {
        const tp = await writeTranscript(userRow("p1"), userRow("p2"))
        expect(throttle({ transcript_path: tp, prompt: "p2" }, 1)).toBe(true)
    })

    it("fails open (fires) when the transcript is missing or absent from the payload", () => {
        expect(throttle({ transcript_path: "/nonexistent/t.jsonl", prompt: "p" }, 5)).toBe(true)
        expect(throttle({}, 5)).toBe(true)
    })
})
