/**
 * plan-preview.test.ts — hermetic, reach-through suite. plan-preview is a
 * COMPOSITE: the Claude path runs openInline -> openFile and the Gemini path runs
 * openFile, both FOR REAL. Only the LEAF write wrappers open-file bottoms out in
 * are mocked, by cmdore wrapper reference: `launch` (the IDE spawn) and
 * `setPreview` (the preview flip) — one pair of mocks covers BOTH paths. Nothing
 * spawns.
 *
 * Stdin is real: the hook payload is fed by spying Bun.stdin.text() (+ forcing
 * isTTY off), so readHookInput runs end to end. The `inIdea` gate is forced
 * through the PREEMDECK_FORCE_IN_IDEA env override. Both opens are fire-and-forget
 * (no wait), so the Claude path's real reapLater is neutralized by spying
 * setTimeout (no real 3s ref'd timer is armed). main() is SILENT and ALWAYS 0.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { effect } from "cmdore"
import { launch, setPreview } from "./open-file.ts"
import { main, readHookInput } from "./plan-preview.ts"

let dir = ""
let launched: string[][]
let previewed: string[]
let timerSpy: ReturnType<typeof spyOn>
const savedTTY = process.stdin.isTTY

/** Mock the LEAF write wrappers by reference: record the resolved target launch/preview saw; spawn nothing. */
const mockLeaves = (): void => {
  launched = []
  previewed = []
  effect.mock(launch, async (args: string[]) => {
    launched.push(args)
    return { pid: 4321 } as unknown as Bun.Subprocess
  })
  effect.mock(setPreview, async (p: string) => {
    previewed.push(p)
  })
}

/** Feed `payload` to the hook's stdin (real readHookInput path): isTTY off + Bun.stdin.text() resolves the JSON. */
const feedStdin = (payload: string): ReturnType<typeof spyOn> => {
  ;(process.stdin as { isTTY?: boolean }).isTTY = false
  return spyOn(Bun.stdin, "text").mockResolvedValue(payload)
}

beforeEach(() => {
  process.env.PREEMDECK_FORCE_IN_IDEA = "1"
  effect.reset()
  mockLeaves()
  // Both plan-preview opens are no-wait: neutralize the Claude path's real reap
  // timer so no ref'd 3s timer outlives the suite (the temp leaks; reaped below).
  timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
    void fn
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as never)
})
afterEach(async () => {
  delete process.env.PREEMDECK_FORCE_IN_IDEA
  effect.reset()
  timerSpy.mockRestore()
  ;(process.stdin as { isTTY?: boolean }).isTTY = savedTTY
  if (dir) {
    await rm(dir, { recursive: true, force: true })
    dir = ""
  }
})

describe("readHookInput", () => {
  test("parses JSON", async () => {
    const stdinSpy = feedStdin('{"tool_input": {"plan": "hi"}}')
    try {
      expect(await readHookInput()).toEqual({ tool_input: { plan: "hi" } })
    } finally {
      stdinSpy.mockRestore()
    }
  })

  test("garbage and empty yield {}", async () => {
    let stdinSpy = feedStdin("not json")
    try {
      expect(await readHookInput()).toEqual({})
      stdinSpy.mockRestore()
      stdinSpy = feedStdin("")
      expect(await readHookInput()).toEqual({})
    } finally {
      stdinSpy.mockRestore()
    }
  })
})

describe("main", () => {
  test("Claude inline plan string -> openInline -> openFile -> launch, with preview, exits 0", async () => {
    const plan = "# Plan\n\n- step"
    const stdinSpy = feedStdin(JSON.stringify({ tool_input: { plan } }))
    try {
      expect(await main()).toBe(0)
      // openInline spilled to a real .md temp and opened it fire-and-forget...
      expect(launched.length).toBe(1)
      const target = launched[0]?.at(-1) as string
      expect(target.endsWith(".md")).toBe(true)
      // ...and the preview leaf fired on that same resolved target.
      expect(previewed).toEqual([target])
      // The real reapLater armed exactly one (neutralized) timer for the temp.
      expect(timerSpy.mock.calls.length).toBe(1)
    } finally {
      stdinSpy.mockRestore()
    }
  })

  test("Gemini plan_path -> openFile -> launch directly, with preview, exits 0", async () => {
    dir = await mkdtemp(join(tmpdir(), "preemdeck-planpreview-"))
    const planPath = join(dir, "plan.md")
    await writeFile(planPath, "# Plan\n")
    const stdinSpy = feedStdin(JSON.stringify({ tool_input: { plan_path: planPath } }))
    try {
      expect(await main()).toBe(0)
      expect(launched.length).toBe(1)
      // openFile resolves the path; launch + preview saw the resolved target.
      expect(launched[0]?.at(-1)).toBe(planPath)
      expect(previewed).toEqual([planPath])
      // openFile's own path does NOT reap (no temp); no timer armed.
      expect(timerSpy.mock.calls.length).toBe(0)
    } finally {
      stdinSpy.mockRestore()
    }
  })

  test("plan_path takes precedence over plan", async () => {
    dir = await mkdtemp(join(tmpdir(), "preemdeck-planpreview-"))
    const planPath = join(dir, "plan.md")
    await writeFile(planPath, "# Plan\n")
    const stdinSpy = feedStdin(JSON.stringify({ tool_input: { plan: "inline", plan_path: planPath } }))
    try {
      expect(await main()).toBe(0)
      expect(launched.length).toBe(1)
      expect(launched[0]?.at(-1)).toBe(planPath)
      expect(previewed).toEqual([planPath])
    } finally {
      stdinSpy.mockRestore()
    }
  })

  test.each([
    JSON.stringify({}),
    JSON.stringify({ tool_input: {} }),
    JSON.stringify({ tool_input: { plan: "   " } }),
    JSON.stringify({ tool_input: { plan_path: "" } }),
    JSON.stringify({ tool_input: { plan: ["not", "a", "str"] } }),
    JSON.stringify({ tool_input: "not-a-dict" }),
    "not json",
    "",
  ])("no-op (no launch) for %p", async (payload) => {
    const stdinSpy = feedStdin(payload)
    try {
      expect(await main()).toBe(0)
      expect(launched).toEqual([])
      expect(previewed).toEqual([])
    } finally {
      stdinSpy.mockRestore()
    }
  })

  test("host-name positional is accepted and ignored (Claude path still opens)", async () => {
    const stdinSpy = feedStdin(JSON.stringify({ tool_input: { plan: "# Plan" } }))
    try {
      // hosts may invoke `plan-preview Gemini`; cmdore binds it, dispatch ignores it.
      expect(await main(["Gemini"])).toBe(0)
      expect(launched.length).toBe(1)
    } finally {
      stdinSpy.mockRestore()
    }
  })

  test("gate: no IDE -> no open, exits 0", async () => {
    process.env.PREEMDECK_FORCE_IN_IDEA = "0"
    const stdinSpy = feedStdin(JSON.stringify({ tool_input: { plan: "# Plan" } }))
    try {
      expect(await main()).toBe(0)
      expect(launched).toEqual([])
      expect(previewed).toEqual([])
    } finally {
      stdinSpy.mockRestore()
    }
  })

  test("swallows a leaf failure and exits 0", async () => {
    effect.mock(launch, async () => {
      throw new Error("IDE went away")
    })
    const stdinSpy = feedStdin(JSON.stringify({ tool_input: { plan: "# Plan" } }))
    try {
      expect(await main()).toBe(0)
    } finally {
      stdinSpy.mockRestore()
    }
  })
})
