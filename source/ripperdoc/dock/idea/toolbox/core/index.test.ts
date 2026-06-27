/**
 * index.test.ts — the cross-platform core surface (not mac-specific). Port of
 * test_core.py.
 *
 * Two guarantees: the Linux module's still-unimplemented entry points (inIdea,
 * resolveLogDir) throw NotImplementedError, and the public API re-exported from
 * `index` is present and wired to the running platform (this host is darwin, so
 * it routes to idea_mac).
 */

import { describe, expect, test } from "bun:test"
import * as ideaLinux from "./idea-linux.ts"
import * as ideaMac from "./idea-mac.ts"
import * as core from "./index.ts"

describe("linux module", () => {
    // resolveExecPath is implemented (its /proc ancestry walk is covered in
    // idea-linux.test.ts); inIdea and resolveLogDir are not yet, so they still
    // throw NotImplementedError.
    test("inIdea throws NotImplementedError", () => {
        expect(() => ideaLinux.inIdea()).toThrow("not implemented for Linux")
    })
    test("resolveLogDir throws NotImplementedError", () => {
        expect(() => ideaLinux.resolveLogDir()).toThrow("not implemented for Linux")
    })
})

describe("public API", () => {
    test("exposes the full engine surface the CLIs import", () => {
        const exported = new Set(Object.keys(core))
        for (const name of [
            "IdeaError",
            "NotImplementedError",
            "escapeGroovy",
            "runGroovy",
            "runGroovyOn",
            "inIdea",
            "resolveExecPath",
            "resolveExecPaths",
            "resolveLogDir",
            "launch",
            "reapLater",
            "REAP_DELAY_MS",
            "setPreview",
            "previewUrl",
            "webpreviewOpenBody",
            "HTML_PREVIEW_EXTS"
        ]) {
            expect(exported.has(name)).toBe(true)
        }
    })

    test("detection is wired to the running platform's impl", () => {
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
