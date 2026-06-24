/**
 * open-inline.test.ts — hermetic, reach-through suite. open-inline is a COMPOSITE
 * over open-file: openInline spills the string to a real temp (writeTemp), then
 * calls openFile, which is allowed to RUN FOR REAL. Only the LEAF write wrappers
 * open-file bottoms out in are mocked, by cmdore wrapper reference: `launch` (the
 * IDE spawn) and `setPreview` (the preview flip). Nothing spawns.
 *
 * The temp write is real, so a recorder `launch` can snapshot what was spilled.
 * The `--wait` read-back is the REAL FS: the mocked launch writes EDITED to the
 * resolved target on the wait path, then openFile's real readFile reads it. The
 * `inIdea` gate is forced through the PREEMDECK_FORCE_IN_IDEA env override.
 *
 * openInline's OWN effects stay real & seam-free: writeTemp -> real FS; reapLater
 * -> real, but the no-wait tests spy on setTimeout to confirm a reap was
 * scheduled without arming the real 3s ref'd timer.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import { effect } from "cmdore"
import { exists } from "../../../../lib/fs.ts"
import { launch, setPreview } from "./open-file.ts"
import { main, openInline } from "./open-inline.ts"

const EDITED = "EDITED\n"
let calls: Array<{ args: string[]; wait: boolean; seen: string }>

/**
 * Mock the LEAF `launch` wrapper by reference: spawn nothing; snapshot the temp
 * NOW (the spilled content, before any cleanup) keyed off the resolved target
 * (last argv), record argv + wait, and on the wait path write `edits` back to it
 * so openInline -> openFile's real readFile returns it.
 */
const mockLaunch = (edits?: string): void => {
  effect.mock(launch, async (args: string[], options: { wait?: boolean } = {}) => {
    const wait = options.wait ?? false
    const target = args[args.length - 1] as string
    const seen = await readFile(target, { encoding: "utf8" })
    calls.push({ args, wait, seen })
    if (wait && edits !== undefined) {
      await writeFile(target, edits)
    }
    return { pid: 4321 } as unknown as Bun.Subprocess
  })
}

beforeEach(() => {
  calls = []
  process.env.PREEMDECK_FORCE_IN_IDEA = "1"
  effect.reset()
  mockLaunch()
})
afterEach(() => {
  delete process.env.PREEMDECK_FORCE_IN_IDEA
  effect.reset()
})

describe("openInline", () => {
  test("wait roundtrips and cleans up the temp", async () => {
    mockLaunch(EDITED)
    const content = "hello inline\nsecond line\n"
    expect(await openInline(content, { wait: true })).toBe(EDITED)
    expect(calls.length).toBe(1)
    expect(calls[0]?.wait).toBe(true)
    expect(calls[0]?.seen).toBe(content)
    const target = calls[0]?.args.at(-1) as string
    expect(target.endsWith(".txt")).toBe(true)
    expect(await exists(target)).toBe(false)
  })

  test("no-wait returns null and schedules a reap (real reapLater, timer neutralized)", async () => {
    const content = "fire and forget\n"
    const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      void fn // don't fire: just record that a reap was armed
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as never)
    try {
      expect(await openInline(content)).toBeNull()
      expect(calls[0]?.wait).toBe(false)
      expect(calls[0]?.seen).toBe(content)
      // reapLater armed exactly one (ref'd) timer for the spilled temp.
      expect(timerSpy.mock.calls.length).toBe(1)
      // The reap was a spy, so the temp is still on disk; clean it up.
      const target = calls[0]?.args.at(-1) as string
      expect(await exists(target)).toBe(true)
      await rm(target, { force: true })
    } finally {
      timerSpy.mockRestore()
    }
  })

  test("suffix override threads to the temp name", async () => {
    mockLaunch(EDITED)
    expect(await openInline("print('hi')\n", { suffix: ".py", wait: true })).toBe(EDITED)
    expect((calls[0]?.args.at(-1) as string).endsWith(".py")).toBe(true)
    expect(await exists(calls[0]?.args.at(-1) as string)).toBe(false)
  })

  test("default does not request preview (setPreview never fires)", async () => {
    const previewed: string[] = []
    effect.mock(setPreview, async (p: string) => {
      previewed.push(p)
    })
    const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      void fn
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as never)
    try {
      expect(await openInline("x\n")).toBeNull()
      expect(previewed.length).toBe(0)
    } finally {
      timerSpy.mockRestore()
    }
  })

  test("preview threads through openFile to setPreview (leaf)", async () => {
    mockLaunch(EDITED)
    const previewed: string[] = []
    effect.mock(setPreview, async (p: string) => {
      previewed.push(p)
    })
    expect(await openInline("# title\n", { suffix: ".md", wait: true, preview: true })).toBe(EDITED)
    expect(previewed.length).toBe(1)
    expect((calls[0]?.args.at(-1) as string).endsWith(".md")).toBe(true)
    // setPreview was handed the same resolved target launch opened.
    expect(previewed[0]).toBe(calls[0]?.args.at(-1))
  })
})

describe("main", () => {
  test("inline only -> launch wait=false, prints nothing, returns 0", async () => {
    const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      void fn
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as never)
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never)
    try {
      expect(await main(["some text"])).toBe(0)
      expect(calls[0]?.wait).toBe(false)
      expect(calls[0]?.seen).toBe("some text")
      expect(outSpy.mock.calls.length).toBe(0)
    } finally {
      outSpy.mockRestore()
      timerSpy.mockRestore()
    }
  })

  test("--suffix reaches the temp", async () => {
    const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      void fn
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as never)
    try {
      expect(await main(["x = 1", "--suffix", ".py"])).toBe(0)
      expect((calls[0]?.args.at(-1) as string).endsWith(".py")).toBe(true)
    } finally {
      timerSpy.mockRestore()
    }
  })

  test("--wait prints edited contents verbatim", async () => {
    mockLaunch(EDITED)
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never)
    try {
      expect(await main(["body", "--wait"])).toBe(0)
      expect(calls[0]?.wait).toBe(true)
      expect(outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toBe(EDITED)
    } finally {
      outSpy.mockRestore()
    }
  })

  test("--preview threads to the leaf setPreview", async () => {
    const previewed: string[] = []
    effect.mock(setPreview, async (p: string) => {
      previewed.push(p)
    })
    const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      void fn
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as never)
    try {
      expect(await main(["# title", "--suffix", ".md", "--preview"])).toBe(0)
      expect(previewed.length).toBe(1)
    } finally {
      timerSpy.mockRestore()
    }
  })

  test("no live IDE -> 1 before any launch", async () => {
    process.env.PREEMDECK_FORCE_IN_IDEA = "0"
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
    try {
      expect(await main(["body"])).toBe(1)
      expect(calls).toEqual([])
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain(
        "open-inline: no JetBrains IDE in the process ancestry",
      )
    } finally {
      errSpy.mockRestore()
    }
  })

  test("missing inline -> CmdoreError mapped to exit 2 + open-inline: stderr", async () => {
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
    try {
      expect(await main([])).toBe(2)
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("open-inline:")
    } finally {
      errSpy.mockRestore()
    }
  })
})
