/**
 * diff-inline.test.ts — hermetic tests. The worker delegate
 * (diffFile), the reaper, and inIdea are injected via `_internals`. A spy diffFile
 * snapshots each temp's contents at call time (before cleanup).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFile, unlink } from "node:fs/promises";
import { exists } from "../../../../lib/fs.ts";
import { _internals, diffInline, main } from "./diff-inline.ts";

const RECONCILED = "RECONCILED\n";
const real = {
  inIdea: _internals.inIdea,
  diffFile: _internals.diffFile,
  reapLater: _internals.reapLater,
  diffInline: _internals.diffInline,
};
let snap: { target: string; suggestion: string; wait: boolean; contents: Record<string, string> };
let reaped: string[][];

const spy = (result: string | null = RECONCILED) => {
  snap = { target: "", suggestion: "", wait: false, contents: {} };
  // diffFile's real signature takes `wait` as a positional boolean.
  return async (target: string, suggestion: string, wait = false) => {
    snap.target = target;
    snap.suggestion = suggestion;
    snap.wait = wait;
    snap.contents[target] = await readFile(target, { encoding: "utf8" });
    snap.contents[suggestion] = await readFile(suggestion, { encoding: "utf8" });
    return result;
  };
};

beforeEach(() => {
  reaped = [];
  _internals.inIdea = () => true;
  _internals.diffFile = spy();
  _internals.reapLater = (paths: Iterable<string>) => {
    reaped.push([...paths]);
  };
});
afterEach(() => {
  _internals.inIdea = real.inIdea;
  _internals.diffFile = real.diffFile;
  _internals.reapLater = real.reapLater;
  _internals.diffInline = real.diffInline;
});

describe("diffInline", () => {
  test("spills target/suggestion in order, returns reconciled, cleans up on wait", async () => {
    expect(await diffInline("alpha", "beta", { wait: true })).toBe(RECONCILED);
    expect(snap.contents[snap.target]).toBe("alpha");
    expect(snap.contents[snap.suggestion]).toBe("beta");
    expect(await exists(snap.target)).toBe(false);
    expect(await exists(snap.suggestion)).toBe(false);
  });

  test("suffix threads to both temp names", async () => {
    await diffInline("a", "b", { suffix: ".py", wait: true });
    expect(snap.target.endsWith(".py")).toBe(true);
    expect(snap.suggestion.endsWith(".py")).toBe(true);
  });

  test("no-wait returns null and schedules a reap for both temps", async () => {
    _internals.diffFile = spy(null);
    expect(await diffInline("x", "y")).toBeNull();
    expect(reaped).toEqual([[snap.target, snap.suggestion]]);
    // The reap seam is a spy; clean up the still-present temps.
    for (const p of [snap.target, snap.suggestion]) if (await exists(p)) await unlink(p);
  });
});

describe("main", () => {
  test("two strings -> 0, wait prints LEFT", async () => {
    _internals.diffInline = async () => RECONCILED;
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    try {
      expect(await main(["old", "new", "--wait"])).toBe(0);
      expect(outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toBe(RECONCILED);
    } finally {
      outSpy.mockRestore();
    }
  });

  test("threads suffix + wait to the worker", async () => {
    const captured: Array<{ suffix: string; wait: boolean }> = [];
    _internals.diffInline = async (_t: string, _s: string, options: { suffix?: string; wait?: boolean } = {}) => {
      captured.push({ suffix: options.suffix ?? ".txt", wait: options.wait ?? false });
      return null;
    };
    await main(["a", "b", "--suffix", ".py", "--wait"]);
    expect(captured[0]).toEqual({ suffix: ".py", wait: true });
  });

  test("outside JetBrains -> 1 before work", async () => {
    _internals.inIdea = () => false;
    let reached = false;
    _internals.diffInline = async () => {
      reached = true;
      return null;
    };
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      expect(await main(["a", "b"])).toBe(1);
      expect(reached).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });

  test.each([[[]], [["only"]], [["a", "b", "c"]]])("wrong arg count %p -> exit 2", async (argv) => {
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      await expect(main(argv)).rejects.toThrow("exit:2");
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("usage: diff-inline");
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
