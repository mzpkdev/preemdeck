/**
 * turn-notify.test.ts — hermetic suite for the turn-end balloon hook.
 *
 * Three collaborators, handled by kind:
 *   - notify (the WRITE): reach through the REAL engine notify() (notify.ts) and
 *     effect.mock the leaf it bottoms out in — runGroovy — to capture the emitted
 *     Groovy. The title/body land as escaped string literals inside that script.
 *   - gitBranch (a value-bearing READ): the happy path drives the REAL gitBranch
 *     through a real temp git repo (git init + a commit, run from there). The
 *     awkward error branches (detached HEAD, exit 128, git-not-found) inject a
 *     stub through main()'s `deps` parameter-DI seam.
 *   - readHookInput (the stdin READ): real reads driven by the isTTY flag + a
 *     Bun.stdin.text spy; plus a true end-to-end subprocess pipe for the host
 *     invocation contract (`turn-notify Gemini` reading stdin).
 *
 * The inIdea gate is forced through the PREEMDECK_FORCE_IN_IDEA env override.
 * No mock.module (which leaks across Bun's single-run suite).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { effect } from "cmdore"
import { runGroovy } from "./notify.ts"
import {
  cleanGist,
  GIST_MAX,
  gitBranch,
  main,
  payloadGist,
  readHookInput,
  type TurnNotifyDeps,
  title,
} from "./turn-notify.ts"

/** Captured Groovy scripts from the mocked runGroovy leaf (the real notify() ran). */
let scripts: string[]

/** Mock the runGroovy wrapper by reference: capture the generated Groovy, run nothing. */
const mockRunGroovy = (): void => {
  effect.mock(runGroovy, async (groovy: string) => {
    scripts.push(groovy)
  })
}

beforeEach(() => {
  scripts = []
  process.env.PREEMDECK_FORCE_IN_IDEA = "1"
  effect.reset()
  mockRunGroovy()
})
afterEach(() => {
  delete process.env.PREEMDECK_FORCE_IN_IDEA
  effect.reset()
})

// --- pure formatters ---------------------------------------------------------

describe("cleanGist", () => {
  test("strips markdown, takes first answer line", () => {
    const text = '> ### Re: "old"\n\n**Yes** — the `pid` lives in the [backend](http://x) only.'
    expect(cleanGist(text)).toBe("Yes — the pid lives in the backend only.")
  })

  test("truncates on a word boundary with an ellipsis", () => {
    const gist = cleanGist("word ".repeat(60))
    expect([...gist].length).toBeLessThanOrEqual(GIST_MAX + 1)
    expect(gist.endsWith("…")).toBe(true)
    expect(gist).not.toContain("  ")
  })
})

describe("title", () => {
  test("project · branch", () => {
    expect(title("Claude", "/work/acme", "main")).toBe("acme · main")
  })
  test("trailing slash tolerated", () => {
    expect(title("Claude", "/work/acme/", null)).toBe("acme")
  })
  test("host fallback head", () => {
    expect(title("Claude", null, null)).toBe("Claude")
  })
})

describe("payloadGist", () => {
  test("reads each host field", () => {
    expect(payloadGist({ last_assistant_message: "**Done** — wired it." })).toBe("Done — wired it.")
    expect(payloadGist({ prompt_response: "Converted to async/await." })).toBe("Converted to async/await.")
  })
  test("null for missing, blank, and sentinel", () => {
    expect(payloadGist({})).toBeNull()
    expect(payloadGist({ last_assistant_message: null })).toBeNull()
    expect(payloadGist({ prompt_response: "   " })).toBeNull()
    expect(payloadGist({ prompt_response: "[no response text]" })).toBeNull()
  })
})

// --- branch fallback: REAL gitBranch through a real temp git repo ------------

describe("gitBranch (real git)", () => {
  let repo = ""
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "preemdeck-turn-git-"))
    const git = (...args: string[]) => Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
    await git("init", "-b", "feature/x").exited
    await git("config", "user.email", "t@t").exited
    await git("config", "user.name", "t").exited
    await git("commit", "--allow-empty", "-m", "init").exited
  })
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  test("returns the current branch of a real repo", async () => {
    expect(await gitBranch(repo)).toBe("feature/x")
  })

  test("null for no cwd", async () => {
    expect(await gitBranch(null)).toBeNull()
    expect(await gitBranch(undefined)).toBeNull()
    expect(await gitBranch("")).toBeNull()
  })

  test("null outside a repo (non-zero exit)", async () => {
    const bare = await mkdtemp(join(tmpdir(), "preemdeck-turn-nogit-"))
    try {
      expect(await gitBranch(bare)).toBeNull()
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })
})

// --- branch fallback: awkward error branches via the deps DI seam ------------

describe("gitBranch error branches (injected)", () => {
  const drive = async (branch: string | null): Promise<Array<{ title: string }>> => {
    const calls: Array<{ title: string }> = []
    effect.reset()
    effect.mock(runGroovy, async (groovy: string) => {
      // Title literal is the head between `new Notification("idea.toolbox", "` and the next `"`.
      const m = groovy.match(/new Notification\("idea\.toolbox", "([^"]*)"/)
      calls.push({ title: m?.[1] ?? "" })
    })
    const deps: TurnNotifyDeps = { gitBranch: async () => branch }
    await runWithStdin(JSON.stringify({ cwd: "/work/acme", last_assistant_message: "ok" }), () =>
      main(["Claude"], deps),
    )
    return calls
  }

  test("detached HEAD -> branchless title (gitBranch stub returns null)", async () => {
    // A real detached HEAD makes gitBranch return null; the DI stub stands in for it.
    const calls = await drive(null)
    expect(calls[0]?.title).toBe("acme")
  })

  test("exit 128 (not a repo) -> branchless title", async () => {
    const calls = await drive(null)
    expect(calls[0]?.title).toBe("acme")
  })

  test("git-not-found (spawn throws) -> branchless title", async () => {
    // gitBranch swallows the spawn error to null; the DI stub models that outcome.
    const calls = await drive(null)
    expect(calls[0]?.title).toBe("acme")
  })

  test("branch present -> title carries it", async () => {
    const calls = await drive("feat/codex")
    expect(calls[0]?.title).toBe("acme · feat/codex")
  })
})

// --- stdin reader ------------------------------------------------------------

/** Run `fn` with stdin driven by an isTTY=false + a Bun.stdin.text spy (real read path). */
const runWithStdin = async <T>(payload: string, fn: () => Promise<T>): Promise<T> => {
  const savedTTY = (process.stdin as { isTTY?: boolean }).isTTY
  ;(process.stdin as { isTTY?: boolean }).isTTY = false
  const stdinSpy = spyOn(Bun.stdin, "text").mockResolvedValue(payload)
  try {
    return await fn()
  } finally {
    stdinSpy.mockRestore()
    ;(process.stdin as { isTTY?: boolean }).isTTY = savedTTY
  }
}

describe("readHookInput", () => {
  const savedTTY = process.stdin.isTTY
  const setTTY = (v: boolean) => {
    ;(process.stdin as { isTTY?: boolean }).isTTY = v
  }
  afterEach(() => {
    ;(process.stdin as { isTTY?: boolean }).isTTY = savedTTY
  })

  test("parses JSON", async () => {
    setTTY(false)
    const stdinSpy = spyOn(Bun.stdin, "text").mockResolvedValue('{"cwd": "/x", "last_assistant_message": "hi"}')
    try {
      expect(await readHookInput()).toEqual({ cwd: "/x", last_assistant_message: "hi" })
    } finally {
      stdinSpy.mockRestore()
    }
  })

  test("garbage and empty yield {}", async () => {
    setTTY(false)
    let stdinSpy = spyOn(Bun.stdin, "text").mockResolvedValue("not json")
    try {
      expect(await readHookInput()).toEqual({})
      stdinSpy.mockRestore()
      stdinSpy = spyOn(Bun.stdin, "text").mockResolvedValue("")
      expect(await readHookInput()).toEqual({})
    } finally {
      stdinSpy.mockRestore()
    }
  })

  test("tty yields {} without reading", async () => {
    setTTY(true)
    expect(await readHookInput()).toEqual({})
  })
})

// --- main() end to end: reach through the real notify(), capture the Groovy --

/** Extract the title + content literals from the captured notification Groovy. */
const balloon = (groovy: string): { title: string; body: string } => {
  const m = groovy.match(/new Notification\("idea\.toolbox", "([^"]*)", "([^"]*)"/)
  return { title: m?.[1] ?? "", body: m?.[2] ?? "" }
}

describe("main (reach-through notify)", () => {
  test("Claude gist from last_assistant_message + git branch", async () => {
    const deps: TurnNotifyDeps = { gitBranch: async () => "main" }
    const code = await runWithStdin(
      JSON.stringify({ cwd: "/work/acme", last_assistant_message: "Probed the hook." }),
      () => main(["Claude"], deps),
    )
    expect(code).toBe(0)
    expect(scripts.length).toBe(1)
    expect(balloon(scripts[0] as string)).toEqual({ title: "acme · main", body: "Probed the hook." })
  })

  test("Gemini gist from prompt_response", async () => {
    const deps: TurnNotifyDeps = { gitBranch: async () => "main" }
    await runWithStdin(
      JSON.stringify({ cwd: "/work/acme", prompt_response: "Converted the middleware to async/await." }),
      () => main(["Gemini"], deps),
    )
    expect(balloon(scripts[0] as string)).toEqual({
      title: "acme · main",
      body: "Converted the middleware to async/await.",
    })
  })

  test("tool-only turn falls back to host-label body", async () => {
    const deps: TurnNotifyDeps = { gitBranch: async () => "feat/codex" }
    expect(
      await runWithStdin(JSON.stringify({ cwd: "/work/acme", last_assistant_message: null }), () =>
        main(["Codex"], deps),
      ),
    ).toBe(0)
    expect(balloon(scripts[0] as string)).toEqual({ title: "acme · feat/codex", body: "Codex finished responding" })
  })

  test("HTML-escapes dynamic text", async () => {
    const deps: TurnNotifyDeps = { gitBranch: async () => null }
    await runWithStdin(JSON.stringify({ cwd: "/x/proj", last_assistant_message: "use <T> & <U>" }), () =>
      main(["Claude"], deps),
    )
    expect(balloon(scripts[0] as string).body).toBe("use &lt;T&gt; &amp; &lt;U&gt;")
  })

  test("no payload, no cwd -> host-label title head + fallback body", async () => {
    const deps: TurnNotifyDeps = { gitBranch: async () => null }
    const savedPwd = process.env.PWD
    delete process.env.PWD
    try {
      expect(await runWithStdin("{}", () => main(["Gemini"], deps))).toBe(0)
      expect(balloon(scripts[0] as string)).toEqual({ title: "Gemini", body: "Gemini finished responding" })
    } finally {
      if (savedPwd === undefined) delete process.env.PWD
      else process.env.PWD = savedPwd
    }
  })

  test("no host positional -> 'Agent' fallback", async () => {
    const deps: TurnNotifyDeps = { gitBranch: async () => null }
    const savedPwd = process.env.PWD
    delete process.env.PWD
    try {
      await runWithStdin("{}", () => main([], deps))
      expect(balloon(scripts[0] as string)).toEqual({ title: "Agent", body: "Agent finished responding" })
    } finally {
      if (savedPwd === undefined) delete process.env.PWD
      else process.env.PWD = savedPwd
    }
  })

  test("gate: no IDE -> no balloon, exit 0", async () => {
    process.env.PREEMDECK_FORCE_IN_IDEA = "0"
    expect(await runWithStdin(JSON.stringify({ cwd: "/work/acme" }), () => main(["Claude"]))).toBe(0)
    expect(scripts).toEqual([])
  })

  test("notify failure is swallowed -> still exit 0", async () => {
    // The real notify() bottoms out in runGroovy; a throwing leaf must not escape main().
    effect.reset()
    effect.mock(runGroovy, async () => {
      throw new Error("ide bridge blew up")
    })
    const deps: TurnNotifyDeps = { gitBranch: async () => "main" }
    expect(
      await runWithStdin(JSON.stringify({ cwd: "/work/acme", last_assistant_message: "x" }), () =>
        main(["Claude"], deps),
      ),
    ).toBe(0)
  })
})

// --- host invocation contract: real subprocess, real stdin pipe --------------

describe("invocation contract (Gemini hook)", () => {
  test("`turn-notify.ts Gemini` reads stdin and exits 0", async () => {
    // gemini-extension.json wires `turn-notify.ts Gemini` as the AfterAgent hook,
    // feeding the payload on stdin. Drive it for real: spawn the CLI with the host
    // positional and a piped JSON payload, IDE gate forced OFF so nothing spawns
    // a Groovy bridge — we only assert the contract (reads stdin, exits 0).
    const here = new URL(".", import.meta.url).pathname
    const entry = join(here, "turn-notify.ts")
    const payload = JSON.stringify({ cwd: "/work/acme", prompt_response: "done" })
    const child = Bun.spawn(["bun", entry, "Gemini"], {
      stdin: new TextEncoder().encode(payload),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PREEMDECK_FORCE_IN_IDEA: "0" },
    })
    await child.exited
    expect(child.exitCode).toBe(0)
    // Best-effort + SILENT: no stdout noise.
    expect(await new Response(child.stdout).text()).toBe("")
  })
})
