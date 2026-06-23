/**
 * scripts/format_on_edit.test.ts — unit tests for the side-effect format hook.
 *
 * Uses MOCK PATTERN A (inject a fake stdin into `main`) and PATTERN E (a real tmp
 * fixture for the containment / file-existence logic — no fs mocking). The pure
 * helpers (payload parse, path extraction, suffix map) are asserted directly; the
 * end-to-end "right formatter actually runs" check is the behavioral verification
 * step, not a unit test (it would shell out to biome/ruff/mdformat).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTAINMENT_ROOT,
  extractFilePath,
  FORMATTERS,
  readPayload,
  resolveInsideRoot,
  suffix,
} from "./format_on_edit.ts";

function fakeStdin(text: string) {
  return { text: () => Promise.resolve(text) };
}

describe("readPayload", () => {
  test("parses a JSON object", async () => {
    expect(await readPayload(fakeStdin('{"a":1}'))).toEqual({ a: 1 });
  });

  test("empty / invalid / array / non-object stdin -> null (no-op)", async () => {
    expect(await readPayload(fakeStdin(""))).toBeNull();
    expect(await readPayload(fakeStdin("}{ not json"))).toBeNull();
    expect(await readPayload(fakeStdin("[1,2,3]"))).toBeNull();
    expect(await readPayload(fakeStdin("42"))).toBeNull();
    expect(await readPayload(fakeStdin("null"))).toBeNull();
  });
});

describe("extractFilePath", () => {
  test("probes file_path first", () => {
    expect(extractFilePath({ tool_input: { file_path: "/a/b.ts" } })).toBe("/a/b.ts");
  });

  test("falls back to absolute_path then path (Gemini's differing key)", () => {
    expect(extractFilePath({ tool_input: { absolute_path: "/a/c.ts" } })).toBe("/a/c.ts");
    expect(extractFilePath({ tool_input: { path: "/a/d.ts" } })).toBe("/a/d.ts");
  });

  test("first non-empty string wins (empty string skipped)", () => {
    expect(extractFilePath({ tool_input: { file_path: "", path: "/a/e.ts" } })).toBe("/a/e.ts");
  });

  test("missing / non-dict tool_input, or no usable key -> null", () => {
    expect(extractFilePath({})).toBeNull();
    expect(extractFilePath({ tool_input: null })).toBeNull();
    expect(extractFilePath({ tool_input: "x" })).toBeNull();
    expect(extractFilePath({ tool_input: ["a"] })).toBeNull();
    expect(extractFilePath({ tool_input: { other: "/a/f.ts" } })).toBeNull();
    expect(extractFilePath({ tool_input: { file_path: 123 } })).toBeNull();
  });
});

describe("suffix", () => {
  test("lowercased extension, dotfiles have none", () => {
    expect(suffix("/a/b.TS")).toBe(".ts");
    expect(suffix("/a/b.JSON")).toBe(".json");
    expect(suffix("/a/b.Markdown")).toBe(".markdown");
    expect(suffix("/a/no_ext")).toBe("");
    expect(suffix("/a/.bashrc")).toBe("");
    expect(suffix("/a.b/c.py")).toBe(".py");
  });
});

describe("FORMATTERS map", () => {
  test(".ts and .json both route to biome format --write", () => {
    expect(FORMATTERS[".ts"]).toEqual(FORMATTERS[".json"] as string[]);
    expect(FORMATTERS[".ts"]?.join(" ")).toContain("biome");
    expect(FORMATTERS[".ts"]).toContain("format");
    expect(FORMATTERS[".ts"]).toContain("--write");
  });

  test(".py -> uv run ruff format", () => {
    expect(FORMATTERS[".py"]).toEqual(["uv", "run", "--quiet", "ruff", "format"]);
  });

  test(".md / .markdown -> uv run mdformat", () => {
    expect(FORMATTERS[".md"]).toEqual(["uv", "run", "--quiet", "mdformat"]);
    expect(FORMATTERS[".markdown"]).toEqual(["uv", "run", "--quiet", "mdformat"]);
  });

  test("no formatter for unknown suffixes", () => {
    expect(FORMATTERS[".rs"]).toBeUndefined();
    expect(FORMATTERS[""]).toBeUndefined();
  });
});

describe("resolveInsideRoot (PATTERN E — real tmp fixture)", () => {
  let dir: string;

  beforeEach(() => {
    // A tmp dir UNDER the containment root so the relative_to() guard passes.
    dir = mkdtempSync(join(CONTAINMENT_ROOT, ".fmt-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("an existing file under the root resolves to its absolute path", () => {
    const f = join(dir, "x.ts");
    writeFileSync(f, "const x=1;\n");
    expect(resolveInsideRoot(f)).toBe(f);
  });

  test("a non-existent path -> null", () => {
    expect(resolveInsideRoot(join(dir, "nope.ts"))).toBeNull();
  });

  test("a directory (not a file) -> null", () => {
    const sub = join(dir, "subdir");
    mkdirSync(sub);
    expect(resolveInsideRoot(sub)).toBeNull();
  });

  test("a file OUTSIDE the containment root -> null", () => {
    // tmpdir() is /var/folders/... on macOS, /tmp on Linux — not under $HOME.
    const outside = mkdtempSync(join(tmpdir(), "fmt-outside-"));
    try {
      const f = join(outside, "y.ts");
      writeFileSync(f, "const y=1;\n");
      expect(resolveInsideRoot(f)).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
