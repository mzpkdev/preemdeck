/**
 * open-file.test.ts — orchestration ordering for openFile().
 *
 * The load-bearing invariant: with { wait, preview } the preview flip must fire
 * WHILE the blocking launch is still pending — never after it resolves. Under
 * --wait the IDE's native --wait makes launch() block until the tab closes; if
 * setPreview ran only after that await, it would reopen the just-closed file in
 * preview (and the user would never see the preview while editing).
 *
 * We drive it through the injectable `deps` seam (no IDE): launch blocks on a
 * gate that setPreview releases — mimicking the user closing the tab once the
 * preview is up. A regression to `await launch` BEFORE setPreview would deadlock
 * this test (launch awaits a gate only setPreview can release, but setPreview
 * can't run until launch returns), so the short timeout turns the old ordering
 * into a fast, unambiguous failure.
 */

import { describe, expect, it } from "bun:test"
import { openFile } from "./open-file.ts"

const FAKE_CHILD = undefined as unknown as Bun.Subprocess

describe("openFile orchestration", () => {
    it("flips preview while the launch is still blocking, then reads the file back", async () => {
        const trace: string[] = []
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })

        const path = `${import.meta.dir}/open-file.test.ts`
        const out = await openFile(path, {
            wait: true,
            preview: true,
            deps: {
                launch: async () => {
                    trace.push("launch:start")
                    await gate
                    trace.push("launch:end")
                    return FAKE_CHILD
                },
                setPreview: async () => {
                    trace.push("preview")
                    release() // user closes the tab once the preview is up → launch unblocks
                }
            }
        })

        expect(trace).toEqual(["launch:start", "preview", "launch:end"])
        // wait path reads the real file back; this test file starts with a block comment
        expect(out?.startsWith("/**")).toBe(true)
    }, 2000)

    it("does not flip preview when preview is not requested", async () => {
        const trace: string[] = []
        const out = await openFile(`${import.meta.dir}/open-file.test.ts`, {
            wait: true,
            preview: false,
            deps: {
                launch: async () => {
                    trace.push("launch")
                    return FAKE_CHILD
                },
                setPreview: async () => {
                    trace.push("preview")
                    return undefined
                }
            }
        })
        expect(trace).toEqual(["launch"])
        expect(out?.startsWith("/**")).toBe(true)
    })

    it("returns null on the fire-and-forget path but still flips preview", async () => {
        const trace: string[] = []
        const out = await openFile(`${import.meta.dir}/open-file.test.ts`, {
            wait: false,
            preview: true,
            deps: {
                launch: async () => {
                    trace.push("launch")
                    return FAKE_CHILD
                },
                setPreview: async () => {
                    trace.push("preview")
                    return undefined
                }
            }
        })
        expect(trace).toEqual(["launch", "preview"])
        expect(out).toBeNull()
    })
})
