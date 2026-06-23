/**
 * open_url.test.ts — hermetic port of core/test_open_url.py. resolveExecPath (the
 * live-IDE guard) + previewUrl + inIdea are injected via `_internals` (DI seam).
 * Nothing spawns; previewUrl is a recorder.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { IdeaError, NotImplementedError } from "./core/_errors.ts";
import { _internals, main } from "./open_url.ts";

const real = {
  inIdea: _internals.inIdea,
  resolveExecPath: _internals.resolveExecPath,
  previewUrl: _internals.previewUrl,
};
let previewed: Array<{ url: string; title: string | undefined }>;
let errSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  previewed = [];
  _internals.inIdea = () => true;
  _internals.resolveExecPath = () => "/Applications/WebStorm.app/Contents/MacOS/webstorm";
  _internals.previewUrl = async (url: string, title?: string) => {
    previewed.push({ url, title });
  };
  errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
});
afterEach(() => {
  _internals.inIdea = real.inIdea;
  _internals.resolveExecPath = real.resolveExecPath;
  _internals.previewUrl = real.previewUrl;
  errSpy.mockRestore();
});

const errText = () => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");

describe("main", () => {
  test("valid http url -> delegates to previewUrl, returns 0", async () => {
    expect(await main(["http://localhost:3000"])).toBe(0);
    expect(previewed).toEqual([{ url: "http://localhost:3000", title: undefined }]);
  });

  test("--title threads through", async () => {
    expect(await main(["https://example.com", "--title", "docs"])).toBe(0);
    expect(previewed).toEqual([{ url: "https://example.com", title: "docs" }]);
  });

  test("non-http scheme -> 1 with note, no preview", async () => {
    expect(await main(["ftp://x"])).toBe(1);
    expect(previewed).toEqual([]);
    expect(errText()).toContain("open_url: url must be a non-empty http/https URL");
  });

  test("non-url -> 1 with note", async () => {
    expect(await main(["not-a-url"])).toBe(1);
    expect(previewed).toEqual([]);
  });

  test("no live IDE (resolveExecPath throws) -> 1, no browser fallback", async () => {
    _internals.resolveExecPath = () => {
      throw new IdeaError("no JetBrains IDE in the process ancestry");
    };
    expect(await main(["http://localhost:3000"])).toBe(1);
    expect(previewed).toEqual([]);
    expect(errText()).toContain("open_url:");
  });

  test("stub platform (NotImplementedError) -> 1", async () => {
    _internals.resolveExecPath = () => {
      throw new NotImplementedError("resolve_exec_path is not implemented for Linux yet");
    };
    expect(await main(["http://localhost:3000"])).toBe(1);
  });

  test("outside JetBrains -> 1 before work", async () => {
    _internals.inIdea = () => false;
    expect(await main(["http://localhost:3000"])).toBe(1);
    expect(previewed).toEqual([]);
    expect(errText()).toContain("open_url: no JetBrains IDE in the process ancestry");
  });

  test("missing url -> exit 2", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    try {
      await expect(main([])).rejects.toThrow("exit:2");
      expect(errText()).toContain("the following arguments are required: url");
    } finally {
      exitSpy.mockRestore();
    }
  });
});
