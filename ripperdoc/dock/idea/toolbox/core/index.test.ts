/**
 * index.test.ts — the cross-platform core surface (not mac-specific). Port of
 * test_core.py.
 *
 * Two guarantees: the Linux stub throws NotImplementedError for every entry
 * point, and the public API re-exported from `index` is present and wired to the
 * running platform (this host is darwin, so it routes to idea_mac).
 */

import { describe, expect, test } from "bun:test";
import * as ideaLinux from "./idea_linux.ts";
import * as ideaMac from "./idea_mac.ts";
import * as core from "./index.ts";

describe("linux stub", () => {
  test("inIdea throws NotImplementedError", () => {
    expect(() => ideaLinux.inIdea()).toThrow("not implemented for Linux");
  });
  test("resolveExecPath throws NotImplementedError", () => {
    expect(() => ideaLinux.resolveExecPath()).toThrow("not implemented for Linux");
  });
  test("resolveLogDir throws NotImplementedError", () => {
    expect(() => ideaLinux.resolveLogDir()).toThrow("not implemented for Linux");
  });
});

describe("public API", () => {
  test("exposes the full engine surface the CLIs import", () => {
    const exported = new Set(Object.keys(core));
    for (const name of [
      "IdeaError",
      "NotImplementedError",
      "escapeGroovy",
      "runGroovy",
      "inIdea",
      "resolveExecPath",
      "resolveLogDir",
      "launch",
      "reapLater",
      "REAP_DELAY_MS",
      "setPreview",
      "previewUrl",
      "webpreviewOpenBody",
      "HTML_PREVIEW_EXTS",
    ]) {
      expect(exported.has(name)).toBe(true);
    }
  });

  test("detection is wired to the macOS impl on darwin", () => {
    expect(process.platform).toBe("darwin");
    // index.inIdea delegates to the mac impl: same answer for the same env.
    const saved = process.env["__CFBundleIdentifier"];
    try {
      process.env["__CFBundleIdentifier"] = "com.jetbrains.WebStorm";
      expect(core.inIdea()).toBe(ideaMac.inIdea());
      expect(core.inIdea()).toBe(true);
    } finally {
      if (saved === undefined) delete process.env["__CFBundleIdentifier"];
      else process.env["__CFBundleIdentifier"] = saved;
    }
  });
});
