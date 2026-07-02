/**
 * install-tmux.spec.ts — exercises install-tmux.ts at two layers.
 *
 * UNIT (hermetic): the pure discovery + XML-upsert core is checked directly, with
 * the directory lister injected so no real filesystem is read.
 *
 * E2E (subprocess): run install-tmux.ts against a throwaway $HOME holding a fake
 * JetBrains config tree. --force skips the running-IDE guard. Asserts the real
 * apply → .bak backup → idempotent re-run → --restore round-trip.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    discoverConfigDirs,
    extractValue,
    ideamuxPath,
    isProductDir,
    jetbrainsRoot,
    removeShellPathOption,
    setValueAttr,
    upsertShellPath,
    xmlEscapeAttr,
    xmlUnescapeAttr
} from "./install-tmux"

const context = describe

const SEED = `<application>
  <component name="TerminalOptionsProvider">
    <option name="closeSessionOnLogout" value="false" />
  </component>
</application>
`

const temps: string[] = []
const mkTemp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "pd-ideamux-"))
    temps.push(dir)
    return dir
}
afterEach(() => {
    while (temps.length > 0) {
        rmSync(temps.pop() as string, { recursive: true, force: true })
    }
})

// Spawn the CLI as a real subprocess against a throwaway $HOME.
const run = async (args: string[], home: string): Promise<{ code: number; stdout: string; stderr: string }> => {
    const subprocess = Bun.spawn([process.execPath, join(import.meta.dir, "install-tmux.ts"), ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: home }
    })
    const [stdout, stderr] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text()
    ])
    const code = await subprocess.exited
    return { code, stdout, stderr }
}

describe("install-tmux", () => {
    context("isProductDir — versioned JetBrains config dirs only", () => {
        it("accepts a product dir with a version", () => {
            expect(isProductDir("WebStorm2025.1")).toBe(true)
            expect(isProductDir("IntelliJIdea2024.3")).toBe(true)
            expect(isProductDir("PyCharm2025.2")).toBe(true)
        })
        it("rejects backups, unversioned, and service dirs", () => {
            expect(isProductDir("WebStorm2025.1-backup")).toBe(false)
            expect(isProductDir("Webstorm")).toBe(false)
            expect(isProductDir("PrivacyPolicy")).toBe(false)
            expect(isProductDir("consentOptions")).toBe(false)
        })
    })

    context("jetbrainsRoot — per-platform config root", () => {
        it("is Application Support on macOS", () => {
            expect(jetbrainsRoot("darwin", "/Users/me")).toBe("/Users/me/Library/Application Support/JetBrains")
        })
        it("is XDG ~/.config elsewhere", () => {
            expect(jetbrainsRoot("linux", "/home/me")).toBe("/home/me/.config/JetBrains")
        })
    })

    context("discoverConfigDirs — filter, sort, join (injected lister)", () => {
        it("keeps only product dirs, sorted and joined to the root", async () => {
            const dirs = await discoverConfigDirs("/root", async () => [
                "WebStorm2025.1",
                "PrivacyPolicy",
                "WebStorm2025.1-backup",
                "IntelliJIdea2024.3"
            ])
            expect(dirs).toEqual(["/root/IntelliJIdea2024.3", "/root/WebStorm2025.1"])
        })
        it("is [] when the root is absent (lister throws)", async () => {
            expect(
                await discoverConfigDirs("/nope", async () => {
                    throw new Error("ENOENT")
                })
            ).toEqual([])
        })
    })

    context("XML attribute helpers", () => {
        it("escapes and unescapes round-trip", () => {
            expect(xmlEscapeAttr('a&b<c>"d"')).toBe("a&amp;b&lt;c&gt;&quot;d&quot;")
            expect(xmlUnescapeAttr("a&amp;b&lt;c&gt;&quot;d&quot;")).toBe('a&b<c>"d"')
        })
        it("extracts a value and sets/replaces one", () => {
            expect(extractValue('<option name="shellPath" value="/bin/zsh" />')).toBe("/bin/zsh")
            expect(setValueAttr('<option name="shellPath" value="/bin/zsh" />', "/x")).toBe(
                '<option name="shellPath" value="/x" />'
            )
            expect(setValueAttr('<option name="shellPath" />', "/x")).toBe('<option name="shellPath" value="/x" />')
        })
    })

    context("upsertShellPath — every branch", () => {
        it("writes the skeleton for a missing/empty file", () => {
            const { xml, previous, changed } = upsertShellPath(null, "/ideamux")
            expect(changed).toBe(true)
            expect(previous).toBeNull()
            expect(xml).toContain('<component name="TerminalOptionsProvider">')
            expect(xml).toContain('<option name="shellPath" value="/ideamux" />')
        })
        it("rewrites an existing shellPath, reporting the old value", () => {
            const before =
                '<application>\n  <component name="TerminalOptionsProvider">\n    <option name="shellPath" value="/bin/zsh" />\n  </component>\n</application>\n'
            const { xml, previous, changed } = upsertShellPath(before, "/ideamux")
            expect(changed).toBe(true)
            expect(previous).toBe("/bin/zsh")
            expect(xml).toContain('value="/ideamux"')
            expect(xml).not.toContain('value="/bin/zsh"')
        })
        it("rewrites a legacy myShellPath in place (name kept)", () => {
            const before =
                '<application>\n  <component name="TerminalOptionsProvider">\n    <option name="myShellPath" value="/bin/bash" />\n  </component>\n</application>\n'
            const { xml, previous } = upsertShellPath(before, "/ideamux")
            expect(previous).toBe("/bin/bash")
            expect(xml).toContain('<option name="myShellPath" value="/ideamux" />')
        })
        it("is idempotent when already pointing at the shell path", () => {
            const first = upsertShellPath(null, "/ideamux").xml
            const { changed, previous } = upsertShellPath(first, "/ideamux")
            expect(changed).toBe(false)
            expect(previous).toBe("/ideamux")
        })
        it("injects into a component that has no shell option", () => {
            const before =
                '<application>\n  <component name="TerminalOptionsProvider">\n    <option name="closeSessionOnLogout" value="false" />\n  </component>\n</application>\n'
            const { xml, changed } = upsertShellPath(before, "/ideamux")
            expect(changed).toBe(true)
            expect(xml).toContain('<option name="closeSessionOnLogout" value="false" />')
            expect(xml).toContain('<option name="shellPath" value="/ideamux" />')
        })
        it("expands a self-closing component", () => {
            const before = '<application>\n  <component name="TerminalOptionsProvider" />\n</application>\n'
            const { xml } = upsertShellPath(before, "/ideamux")
            expect(xml).toContain('<component name="TerminalOptionsProvider">')
            expect(xml).toContain('<option name="shellPath" value="/ideamux" />')
            expect(xml).toContain("</component>")
        })
        it("injects the whole component when only <application> exists", () => {
            const before = '<application>\n  <component name="OtherThing" />\n</application>\n'
            const { xml } = upsertShellPath(before, "/ideamux")
            expect(xml).toContain('<component name="OtherThing" />')
            expect(xml).toContain('<component name="TerminalOptionsProvider">')
            expect(xml).toContain('<option name="shellPath" value="/ideamux" />')
        })
        it("escapes a path with XML metacharacters and stays idempotent", () => {
            const { xml } = upsertShellPath(null, "/a&b")
            expect(xml).toContain('value="/a&amp;b"')
            expect(upsertShellPath(xml, "/a&b").changed).toBe(false)
        })
    })

    context("removeShellPathOption — only our own option", () => {
        it("strips the option matching our path", () => {
            const xml = upsertShellPath(null, "/ideamux").xml
            expect(removeShellPathOption(xml, "/ideamux")).not.toContain("shellPath")
        })
        it("leaves a foreign shell path untouched", () => {
            const xml = upsertShellPath(null, "/bin/zsh").xml
            expect(removeShellPathOption(xml, "/ideamux")).toContain('value="/bin/zsh"')
        })
    })

    context("ideamuxPath — deployed wrapper location", () => {
        it("resolves under ~/.preemdeck to the idea toolbox", () => {
            expect(ideamuxPath()).toContain("/.preemdeck/src/ripperdoc/dock/idea/toolbox/ideamux")
        })
    })

    context("CLI e2e — apply, back up, idempotent, restore", () => {
        it("upserts shellPath, backs up, no-ops on re-run, then restores", async () => {
            const home = mkTemp()
            const root = jetbrainsRoot(process.platform, home)
            const optionsDir = join(root, "WebStorm2025.1", "options")
            const file = join(optionsDir, "terminal.xml")
            mkdirSync(optionsDir, { recursive: true })
            writeFileSync(file, SEED)
            // A backup dir must be ignored by discovery.
            mkdirSync(join(root, "WebStorm2025.1-backup", "options"), { recursive: true })

            // Apply.
            const applied = await run(["--force"], home)
            expect(applied.code).toBe(0)
            const afterApply = readFileSync(file, "utf8")
            expect(afterApply).toContain('<option name="shellPath"')
            expect(afterApply).toContain("ideamux")
            expect(afterApply).toContain('name="closeSessionOnLogout"') // preserved
            expect(readFileSync(`${file}.bak`, "utf8")).toBe(SEED) // original backed up

            // Re-run is idempotent: no change, backup not overwritten.
            const again = await run(["--force"], home)
            expect(again.stderr).toContain("already points at ideamux")
            expect(readFileSync(`${file}.bak`, "utf8")).toBe(SEED)

            // Restore.
            const restored = await run(["--restore", "--force"], home)
            expect(restored.code).toBe(0)
            expect(readFileSync(file, "utf8")).toBe(SEED)
            expect(existsSync(`${file}.bak`)).toBe(false)
        })

        it("reports when no JetBrains config dirs exist", async () => {
            const home = mkTemp()
            const { code, stderr } = await run(["--force"], home)
            expect(code).toBe(0)
            expect(stderr).toContain("no JetBrains config dirs")
        })
    })
})
