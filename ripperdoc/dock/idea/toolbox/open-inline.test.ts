/**
 * open-inline.test.ts — hermetic suite. The worker delegate (openFile), the
 * reaper, and inIdea are injected via `_internals`. A recorder openFile snapshots
 * the temp's contents at call time (before cleanup) so we can assert what was
 * spilled and how cleanup is gated on wait.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { IdeaError } from "./core/errors.ts";
import { _internals, main, openInline } from "./open-inline.ts";

const EDITED = "EDITED\n";
const real = {
  inIdea: _internals.inIdea,
  openFile: _internals.openFile,
  reapLater: _internals.reapLater,
  openInline: _internals.openInline,
};
let calls: Array<{ path: string; wait: boolean; preview: boolean; seen: string }>;
let reaped: string[][];

/** A recorder openFile: snapshots the temp now, records path/wait/preview, returns EDITED on wait. */
const recorder = () => {
  return async (path: string, options: { wait?: boolean; preview?: boolean } = {}) => {
    const wait = options.wait ?? false;
    const preview = options.preview ?? false;
    const seen = readFileSync(path, { encoding: "utf8" });
    calls.push({ path, wait, preview, seen });
    return wait ? EDITED : null;
  };
};

beforeEach(() => {
  calls = [];
  reaped = [];
  _internals.inIdea = () => true;
  _internals.openFile = recorder();
  _internals.reapLater = (paths: Iterable<string>) => {
    reaped.push([...paths]);
  };
});
afterEach(() => {
  _internals.inIdea = real.inIdea;
  _internals.openFile = real.openFile;
  _internals.reapLater = real.reapLater;
  _internals.openInline = real.openInline;
});

describe("openInline", () => {
  test("wait roundtrips and cleans up the temp", async () => {
    const content = "hello inline\nsecond line\n";
    expect(await openInline(content, { wait: true })).toBe(EDITED);
    expect(calls.length).toBe(1);
    expect(calls[0]?.wait).toBe(true);
    expect(calls[0]?.seen).toBe(content);
    expect(calls[0]?.path.endsWith(".txt")).toBe(true);
    expect(existsSync(calls[0]?.path as string)).toBe(false);
  });

  test("no-wait returns null and schedules a reap", async () => {
    const content = "fire and forget\n";
    expect(await openInline(content)).toBeNull();
    expect(calls[0]?.wait).toBe(false);
    expect(calls[0]?.seen).toBe(content);
    const path = calls[0]?.path as string;
    expect(reaped).toEqual([[path]]);
    // The reap seam is a spy, so the temp is still on disk; clean it up.
    expect(existsSync(path)).toBe(true);
    unlinkSync(path);
  });

  test("suffix override threads to the temp name", async () => {
    expect(await openInline("print('hi')\n", { suffix: ".py", wait: true })).toBe(EDITED);
    expect(calls[0]?.path.endsWith(".py")).toBe(true);
    expect(existsSync(calls[0]?.path as string)).toBe(false);
  });

  test("IdeaError propagates and the temp is unlinked on the wait path", async () => {
    const seenPaths: string[] = [];
    _internals.openFile = async (path: string) => {
      seenPaths.push(path);
      throw new IdeaError("no running JetBrains IDE found");
    };
    await expect(openInline("oops\n", { wait: true })).rejects.toThrow(IdeaError);
    expect(existsSync(seenPaths[0] as string)).toBe(false);
  });

  test("default does not request preview", async () => {
    _internals.reapLater = () => {};
    expect(await openInline("x\n")).toBeNull();
    expect(calls[0]?.preview).toBe(false);
  });

  test("preview threads to openFile", async () => {
    expect(await openInline("# title\n", { suffix: ".md", wait: true, preview: true })).toBe(EDITED);
    expect(calls[0]?.preview).toBe(true);
    expect(calls[0]?.path.endsWith(".md")).toBe(true);
  });
});

describe("main", () => {
  let captured: Array<{ content: string; suffix: string; wait: boolean; preview: boolean }>;
  beforeEach(() => {
    captured = [];
    _internals.openInline = async (
      content: string,
      options: { suffix?: string; wait?: boolean; preview?: boolean } = {},
    ) => {
      captured.push({
        content,
        suffix: options.suffix ?? ".txt",
        wait: options.wait ?? false,
        preview: options.preview ?? false,
      });
      return null;
    };
  });

  test("inline only -> defaults, no wait", async () => {
    expect(await main(["some text"])).toBe(0);
    expect(captured).toEqual([{ content: "some text", suffix: ".txt", wait: false, preview: false }]);
  });

  test("--suffix reaches the worker", async () => {
    expect(await main(["x = 1", "--suffix", ".py"])).toBe(0);
    expect(captured[0]?.suffix).toBe(".py");
  });

  test("--wait reaches the worker", async () => {
    expect(await main(["body", "--wait"])).toBe(0);
    expect(captured[0]?.wait).toBe(true);
  });

  test("--preview reaches the worker", async () => {
    expect(await main(["# title", "--suffix", ".md", "--preview"])).toBe(0);
    expect(captured[0]).toEqual({ content: "# title", suffix: ".md", wait: false, preview: true });
  });

  test("--wait prints edited contents", async () => {
    _internals.openInline = async () => EDITED;
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    try {
      expect(await main(["body", "--wait"])).toBe(0);
      expect(outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toBe(EDITED);
    } finally {
      outSpy.mockRestore();
    }
  });

  test("missing inline -> exit 2", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      await expect(main([])).rejects.toThrow("exit:2");
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("usage:");
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test("no live IDE -> 1", async () => {
    _internals.openInline = async () => {
      throw new IdeaError("no running JetBrains IDE found");
    };
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      expect(await main(["body"])).toBe(1);
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("open-inline:");
    } finally {
      errSpy.mockRestore();
    }
  });

  test("outside JetBrains -> 1 before work", async () => {
    _internals.inIdea = () => false;
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      expect(await main(["body"])).toBe(1);
      expect(captured).toEqual([]);
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain(
        "open-inline: no JetBrains IDE in the process ancestry",
      );
    } finally {
      errSpy.mockRestore();
    }
  });
});
