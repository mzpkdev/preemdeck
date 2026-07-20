import { describe, expect, it } from "bun:test"
import * as ideaLinux from "./idea-linux"
import * as ideaMac from "./idea-mac"
import * as core from "./index"

const context = describe

describe("core", () => {
    context("linux module", () => {
        it("detects JediTerm from inherited metadata", () => {
            expect(ideaLinux.inIdea({ TERMINAL_EMULATOR: "JetBrains-JediTerm" })).toBe(true)
            expect(ideaLinux.inIdea({})).toBe(false)
        })
    })

    context("public API", () => {
        it("exposes the full engine surface the CLIs import", () => {
            const exported = new Set(Object.keys(core))
            for (const name of [
                "IdeaError",
                "escapeGroovy",
                "runGroovy",
                "runGroovyOn",
                "inIdea",
                "resolveExecPath",
                "resolveExecPaths",
                "resolveLogDir",
                "resolveTabPids",
                "resolveTabTargets",
                "normalizeTabTargets",
                "groovyRenameByPid",
                "groovyRenameByTargets",
                "groovyReadTitleByPid",
                "groovyReadTitleByTargets",
                "groovyFocusByPid",
                "groovyFocusByTargets",
                "launch",
                "reapLater",
                "setPreview",
                "previewUrl",
                "webpreviewOpenBody"
            ]) {
                expect(exported.has(name)).toBe(true)
            }
        })

        it("detection is wired to the running platform's impl", () => {
            // index picks the per-OS module at load; assert the wiring for whatever
            // platform runs this suite (darwin locally, linux in CI).
            if (process.platform === "darwin") {
                const saved = process.env.__CFBundleIdentifier
                try {
                    process.env.__CFBundleIdentifier = "com.jetbrains.WebStorm"
                    expect(core.inIdea()).toBe(ideaMac.inIdea())
                    expect(core.inIdea()).toBe(true)
                } finally {
                    if (saved === undefined) delete process.env.__CFBundleIdentifier
                    else process.env.__CFBundleIdentifier = saved
                }
            } else {
                const saved = process.env.TERMINAL_EMULATOR
                try {
                    process.env.TERMINAL_EMULATOR = "JetBrains-JediTerm"
                    expect(core.inIdea()).toBe(true)
                } finally {
                    if (saved === undefined) delete process.env.TERMINAL_EMULATOR
                    else process.env.TERMINAL_EMULATOR = saved
                }
            }
        })
    })
})
