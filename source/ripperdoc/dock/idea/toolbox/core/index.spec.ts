import { describe, expect, it } from "bun:test"
import * as ideaLinux from "./idea-linux.ts"
import * as ideaMac from "./idea-mac.ts"
import * as core from "./index.ts"

const context = describe

describe("core", () => {
    context("linux module", () => {
        // resolveExecPath is implemented (its /proc ancestry walk is covered in
        // idea-linux.spec.ts); inIdea and resolveLogDir are not yet, so they still
        // throw NotImplementedError.
        it("inIdea throws NotImplementedError", () => {
            expect(() => ideaLinux.inIdea()).toThrow("not implemented for Linux")
        })
        it("resolveLogDir throws NotImplementedError", () => {
            expect(() => ideaLinux.resolveLogDir()).toThrow("not implemented for Linux")
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
                // linux: the stub backs the public API, so detection throws.
                expect(() => core.inIdea()).toThrow("not implemented for Linux")
            }
        })
    })
})
