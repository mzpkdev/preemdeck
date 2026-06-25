/**
 * open-url.test.ts — hermetic suite. The WRITE (previewUrl) is mocked via
 * cmdore's `effect.mock` keyed by the wrapper reference; nothing fires. The
 * `inIdea` gate is forced through the `PREEMDECK_FORCE_IN_IDEA` env override.
 * resolveExecPath (the live-IDE READ guard) runs for real — harmless under the
 * forced gate, and not exercised here.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { effect } from "cmdore"
import { main, openUrl, previewUrl } from "./open-url.ts"

let previewed: Array<{ url: string; title: string | undefined }>
let errSpy: ReturnType<typeof spyOn>

/** Mock the `previewUrl` wrapper by reference: record url + title, fire nothing. */
const mockPreviewUrl = (): void => {
    effect.mock(previewUrl, async (url: string, title?: string) => {
        previewed.push({ url, title })
    })
}

const errText = (): string => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")

beforeEach(() => {
    previewed = []
    process.env.PREEMDECK_FORCE_IN_IDEA = "1"
    effect.reset()
    mockPreviewUrl()
    errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
})
afterEach(() => {
    delete process.env.PREEMDECK_FORCE_IN_IDEA
    effect.reset()
    errSpy.mockRestore()
})

describe("openUrl", () => {
    test("delegates the url + title to previewUrl", async () => {
        await openUrl("https://example.com", "docs")
        expect(previewed).toEqual([{ url: "https://example.com", title: "docs" }])
    })

    test("title defaults to undefined", async () => {
        await openUrl("http://localhost:3000")
        expect(previewed).toEqual([{ url: "http://localhost:3000", title: undefined }])
    })
})

describe("main", () => {
    test("valid http url -> delegates to previewUrl, returns 0", async () => {
        expect(await main(["http://localhost:3000"])).toBe(0)
        expect(previewed).toEqual([{ url: "http://localhost:3000", title: undefined }])
    })

    test("--title threads through", async () => {
        expect(await main(["https://example.com", "--title", "docs"])).toBe(0)
        expect(previewed).toEqual([{ url: "https://example.com", title: "docs" }])
    })

    test("non-http scheme -> 1 with note, no preview", async () => {
        expect(await main(["ftp://x"])).toBe(1)
        expect(previewed).toEqual([])
        expect(errText()).toContain("open-url: url must be a non-empty http/https URL")
    })

    test("non-url -> 1 with note", async () => {
        expect(await main(["not-a-url"])).toBe(1)
        expect(previewed).toEqual([])
    })

    test("no live IDE -> 1, no browser fallback", async () => {
        process.env.PREEMDECK_FORCE_IN_IDEA = "0"
        expect(await main(["http://localhost:3000"])).toBe(1)
        expect(previewed).toEqual([])
        expect(errText()).toContain("open-url: no JetBrains IDE in the process ancestry")
    })

    test("missing url -> CmdoreError mapped to exit 2 + open-url: stderr", async () => {
        expect(await main([])).toBe(2)
        expect(previewed).toEqual([])
        expect(errText()).toContain("open-url:")
    })

    test("--dry-run records the previewUrl but skips the real fire", async () => {
        // No mock: on dry-run cmdore flips effect.enabled off, so the unmocked
        // wrapper records the call and returns undefined without firing.
        effect.reset()
        expect(await main(["http://localhost:3000", "--dry-run"])).toBe(0)
        expect(effect.log.some((entry) => entry.wrapper === previewUrl)).toBe(true)
        expect(previewed.length).toBe(0)
    })
})
