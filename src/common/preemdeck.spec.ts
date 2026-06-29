import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { config, ENV, markdown } from "./preemdeck"

const context = describe

let root = ""

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "preemdeck-spec-"))
})

afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
})

describe("markdown.join", () => {
    it("drops empty and whitespace-only sections and joins with a blank line", () => {
        expect(markdown.join("a", "", "   ", "b")).toBe("a\n\nb")
    })

    it("trims each section before joining", () => {
        expect(markdown.join("  a  ", "\nb\n")).toBe("a\n\nb")
    })

    it("returns an empty string when every section is blank", () => {
        expect(markdown.join("", "   ", "\n")).toBe("")
    })
})

describe("markdown.interpolate", () => {
    it("replaces a known key, including repeated occurrences", () => {
        expect(markdown.interpolate("{{x}} and {{x}}", { x: "Y" })).toBe("Y and Y")
    })

    it("leaves placeholders with unknown keys untouched", () => {
        expect(markdown.interpolate("{{known}} {{unknown}}", { known: "k" })).toBe("k {{unknown}}")
    })

    it("handles multiple keys", () => {
        expect(markdown.interpolate("{{a}}-{{b}}", { a: "1", b: "2" })).toBe("1-2")
    })
})

describe("markdown.read", () => {
    it("reads a file's text", async () => {
        const file = path.join(root, "doc.md")
        await fs.writeFile(file, "# hello\n", "utf8")
        expect(await markdown.read(file)).toBe("# hello\n")
    })
})

describe("ENV.HARNESS_ROOT", () => {
    const KEYS = [
        "GEMINI_SESSION_ID",
        "GEMINI_PROJECT_DIR",
        "CLAUDECODE",
        "PLUGIN_ROOT",
        "CODEX_HOME",
        "CLAUDE_PROJECT_DIR",
        "CLAUDE_PLUGIN_ROOT"
    ]
    const saved: Record<string, string | undefined> = {}

    beforeEach(() => {
        for (const key of KEYS) {
            saved[key] = process.env[key]
            delete process.env[key]
        }
    })

    afterEach(() => {
        for (const key of KEYS) {
            const value = saved[key]
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    })

    context("when a harness-exclusive signal is present", () => {
        it("resolves ~/.gemini from GEMINI_SESSION_ID", () => {
            process.env.GEMINI_SESSION_ID = "s"
            expect(ENV.HARNESS_ROOT).toBe(path.join(os.homedir(), ".gemini"))
        })

        it("resolves ~/.gemini from GEMINI_PROJECT_DIR", () => {
            process.env.GEMINI_PROJECT_DIR = "/w"
            expect(ENV.HARNESS_ROOT).toBe(path.join(os.homedir(), ".gemini"))
        })

        it("resolves ~/.claude from CLAUDECODE=1", () => {
            process.env.CLAUDECODE = "1"
            expect(ENV.HARNESS_ROOT).toBe(path.join(os.homedir(), ".claude"))
        })

        it("resolves ~/.codex from the unprefixed PLUGIN_ROOT", () => {
            process.env.PLUGIN_ROOT = "/p"
            expect(ENV.HARNESS_ROOT).toBe(path.join(os.homedir(), ".codex"))
        })

        it("resolves ~/.codex from CODEX_HOME", () => {
            process.env.CODEX_HOME = "/c"
            expect(ENV.HARNESS_ROOT).toBe(path.join(os.homedir(), ".codex"))
        })
    })

    context("when only a CLAUDE_* compat alias is present", () => {
        it("ignores CLAUDE_PROJECT_DIR (Gemini's alias) and falls back to ~/.claude", () => {
            process.env.CLAUDE_PROJECT_DIR = "/w"
            expect(ENV.HARNESS_ROOT).toBe(path.join(os.homedir(), ".claude"))
        })

        it("identifies codex by PLUGIN_ROOT even when its CLAUDE_PLUGIN_ROOT alias is also set", () => {
            process.env.PLUGIN_ROOT = "/p"
            process.env.CLAUDE_PLUGIN_ROOT = "/p"
            expect(ENV.HARNESS_ROOT).toBe(path.join(os.homedir(), ".codex"))
        })
    })

    context("when signals overlap", () => {
        it("prefers gemini over a stray CODEX_HOME in the environment", () => {
            process.env.GEMINI_SESSION_ID = "s"
            process.env.CODEX_HOME = "/c"
            expect(ENV.HARNESS_ROOT).toBe(path.join(os.homedir(), ".gemini"))
        })
    })

    context("when no signal is present", () => {
        it("falls back to ~/.claude, the installer's default harness", () => {
            expect(ENV.HARNESS_ROOT).toBe(path.join(os.homedir(), ".claude"))
        })
    })
})

describe("ENV.PREEMDECK_ROOT", () => {
    it("resolves ~/.preemdeck under the user's home, regardless of harness", () => {
        expect(ENV.PREEMDECK_ROOT).toBe(path.join(os.homedir(), ".preemdeck"))
    })
})

describe("ENV.PLUGIN_ROOT / ENV.MARKETPLACE_ROOT", () => {
    // Both getters self-locate off the entry script path (process.argv[1]); save
    // and restore it so a fake plugin path can't leak between cases.
    let savedArgv1 = ""

    beforeEach(() => {
        savedArgv1 = process.argv[1] ?? ""
    })

    afterEach(() => {
        process.argv[1] = savedArgv1
    })

    context("when invoked from a plugin script under ripperdoc", () => {
        beforeEach(() => {
            process.argv[1] = "/home/u/.preemdeck/src/ripperdoc/wetware/ghost/scripts/boot.ts"
        })

        it("resolves MARKETPLACE_ROOT to the rack directly under ripperdoc", () => {
            expect(ENV.MARKETPLACE_ROOT).toBe("/home/u/.preemdeck/src/ripperdoc/wetware")
        })

        it("resolves PLUGIN_ROOT to the plugin beneath the rack", () => {
            expect(ENV.PLUGIN_ROOT).toBe("/home/u/.preemdeck/src/ripperdoc/wetware/ghost")
        })
    })

    context("when invoked from a deeper toolbox script", () => {
        it("anchors on ripperdoc regardless of how deep the entry script sits", () => {
            process.argv[1] = "/x/.preemdeck/src/ripperdoc/dock/idea/toolbox/core/reap.ts"
            expect(ENV.MARKETPLACE_ROOT).toBe("/x/.preemdeck/src/ripperdoc/dock")
            expect(ENV.PLUGIN_ROOT).toBe("/x/.preemdeck/src/ripperdoc/dock/idea")
        })
    })

    context("when not running from a ripperdoc plugin", () => {
        it("throws for MARKETPLACE_ROOT", () => {
            process.argv[1] = "/usr/local/bin/something.ts"
            expect(() => ENV.MARKETPLACE_ROOT).toThrow("not running from a ripperdoc plugin")
        })

        it("throws for PLUGIN_ROOT", () => {
            process.argv[1] = "/usr/local/bin/something.ts"
            expect(() => ENV.PLUGIN_ROOT).toThrow("not running from a ripperdoc plugin")
        })
    })
})

describe("ENV.CACHED_PLUGIN_ROOT / ENV.CACHED_MARKETPLACE_ROOT", () => {
    const KEYS = ["GEMINI_SESSION_ID", "GEMINI_PROJECT_DIR", "CLAUDECODE", "PLUGIN_ROOT", "CODEX_HOME"]
    const saved: Record<string, string | undefined> = {}
    let savedArgv1 = ""

    beforeEach(() => {
        for (const key of KEYS) {
            saved[key] = process.env[key]
            delete process.env[key]
        }
        savedArgv1 = process.argv[1] ?? ""
        process.argv[1] = "/home/u/.preemdeck/src/ripperdoc/wetware/ghost/scripts/boot.ts"
    })

    afterEach(() => {
        for (const key of KEYS) {
            const value = saved[key]
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        process.argv[1] = savedArgv1
    })

    context("on claude", () => {
        beforeEach(() => {
            process.env.CLAUDECODE = "1"
        })

        it("nests cache/<rack>/<plugin> under ~/.claude/plugins", () => {
            expect(ENV.CACHED_PLUGIN_ROOT).toBe(
                path.join(os.homedir(), ".claude", "plugins", "cache", "wetware", "ghost")
            )
        })

        it("nests marketplaces/<rack> under ~/.claude/plugins", () => {
            expect(ENV.CACHED_MARKETPLACE_ROOT).toBe(
                path.join(os.homedir(), ".claude", "plugins", "marketplaces", "wetware")
            )
        })
    })

    context("on codex", () => {
        beforeEach(() => {
            process.env.PLUGIN_ROOT = "/codex/plugin/root"
        })

        it("nests cache/<rack>/<plugin> under ~/.codex/plugins", () => {
            expect(ENV.CACHED_PLUGIN_ROOT).toBe(
                path.join(os.homedir(), ".codex", "plugins", "cache", "wetware", "ghost")
            )
        })

        it("puts marketplaces/<rack> at the ~/.codex root, with no plugins/ level", () => {
            expect(ENV.CACHED_MARKETPLACE_ROOT).toBe(path.join(os.homedir(), ".codex", "marketplaces", "wetware"))
        })
    })

    context("on gemini", () => {
        beforeEach(() => {
            process.env.GEMINI_SESSION_ID = "s"
        })

        it("points CACHED_PLUGIN_ROOT at the flat extensions/<plugin> dir", () => {
            expect(ENV.CACHED_PLUGIN_ROOT).toBe(path.join(os.homedir(), ".gemini", "extensions", "ghost"))
        })

        it("throws for CACHED_MARKETPLACE_ROOT, since Gemini has no marketplace", () => {
            expect(() => ENV.CACHED_MARKETPLACE_ROOT).toThrow("Gemini has no marketplace cache")
        })
    })
})

describe("config", () => {
    let restore: PropertyDescriptor | undefined
    let dir = ""
    const file = () => path.join(dir, "preemdeck.json")

    beforeEach(async () => {
        dir = path.join(root, ".preemdeck")
        await fs.mkdir(dir, { recursive: true })
        restore = Object.getOwnPropertyDescriptor(ENV, "PREEMDECK_ROOT")
        Object.defineProperty(ENV, "PREEMDECK_ROOT", { configurable: true, get: () => dir })
    })

    afterEach(() => {
        if (restore) Object.defineProperty(ENV, "PREEMDECK_ROOT", restore)
    })

    it("reads and parses preemdeck.json from PREEMDECK_ROOT", async () => {
        await fs.writeFile(file(), JSON.stringify({ directive: { strategy: "swarm" } }))
        expect(await config.read()).toEqual({ directive: { strategy: "swarm" } })
    })

    it("reads {} when the file is absent", async () => {
        expect(await config.read()).toEqual({})
    })

    it("mutate persists the draft a recipe returns", async () => {
        await fs.writeFile(file(), JSON.stringify({ directive: { strategy: "swarm" } }))
        await config.mutate(() => ({ directive: { strategy: "auto" } }))
        expect(await Bun.file(file()).json()).toEqual({ directive: { strategy: "auto" } })
    })

    it("mutate persists edits applied to the returned draft", async () => {
        await fs.writeFile(file(), JSON.stringify({ a: 1 }))
        await config.mutate((draft) => Object.assign(draft, { b: 2 }))
        expect(await Bun.file(file()).json()).toEqual({ a: 1, b: 2 })
    })

    it("mutate bootstraps from {} when the file is absent", async () => {
        await config.mutate(() => ({ directive: { strategy: "swarm" } }))
        expect(await Bun.file(file()).json()).toEqual({ directive: { strategy: "swarm" } })
    })
})
