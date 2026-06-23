/**
 * merge_inline.test.ts — hermetic port of test_merge_inline.py. The worker
 * delegate (mergeFile), the reaper, and inIdea are injected via `_internals`. A
 * spy mergeFile snapshots each input temp at call time; base is spilled only when
 * present.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { _internals, main, mergeInline } from "./merge_inline.ts";

const MERGED = "MERGED\n";
const real = {
  inIdea: _internals.inIdea,
  mergeFile: _internals.mergeFile,
  reapLater: _internals.reapLater,
  mergeInline: _internals.mergeInline,
};
let snap: { target: string; suggestion: string; base: string | null; wait: boolean; contents: Record<string, string> };
let reaped: string[][];

function spy(result: string | null = MERGED) {
  snap = { target: "", suggestion: "", base: null, wait: false, contents: {} };
  return async (target: string, suggestion: string, base: string | null = null, wait = false) => {
    snap.target = target;
    snap.suggestion = suggestion;
    snap.base = base;
    snap.wait = wait;
    for (const p of [target, suggestion, ...(base !== null ? [base] : [])]) {
      snap.contents[p] = readFileSync(p, { encoding: "utf8" });
    }
    return result;
  };
}

beforeEach(() => {
  reaped = [];
  _internals.inIdea = () => true;
  _internals.mergeFile = spy();
  _internals.reapLater = (paths: Iterable<string>) => {
    reaped.push([...paths]);
  };
});
afterEach(() => {
  _internals.inIdea = real.inIdea;
  _internals.mergeFile = real.mergeFile;
  _internals.reapLater = real.reapLater;
  _internals.mergeInline = real.mergeInline;
});

describe("mergeInline", () => {
  test("spills target+suggestion (no base), returns merged, cleans up on wait", async () => {
    expect(await mergeInline("mine", "theirs", null, { wait: true })).toBe(MERGED);
    expect(snap.contents[snap.target]).toBe("mine");
    expect(snap.contents[snap.suggestion]).toBe("theirs");
    expect(snap.base).toBeNull();
    expect(existsSync(snap.target)).toBe(false);
    expect(existsSync(snap.suggestion)).toBe(false);
  });

  test("spills base when present", async () => {
    await mergeInline("mine", "theirs", "ancestor", { wait: true });
    expect(snap.base).not.toBeNull();
    expect(snap.contents[snap.base as string]).toBe("ancestor");
  });

  test("suffix threads to every temp", async () => {
    await mergeInline("a", "b", "c", { suffix: ".py", wait: true });
    expect(snap.target.endsWith(".py")).toBe(true);
    expect(snap.suggestion.endsWith(".py")).toBe(true);
    expect((snap.base as string).endsWith(".py")).toBe(true);
  });

  test("no-wait returns null and schedules a reap of the input temps (not output)", async () => {
    _internals.mergeFile = spy(null);
    expect(await mergeInline("x", "y", "z")).toBeNull();
    expect(reaped).toEqual([[snap.target, snap.suggestion, snap.base as string]]);
    for (const p of [snap.target, snap.suggestion, snap.base as string]) if (existsSync(p)) unlinkSync(p);
  });
});

describe("main", () => {
  test("--wait prints the merged result", async () => {
    _internals.mergeInline = async () => MERGED;
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    try {
      expect(await main(["mine", "theirs", "--wait"])).toBe(0);
      expect(outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toBe(MERGED);
    } finally {
      outSpy.mockRestore();
    }
  });

  test("threads base + suffix + wait to the worker", async () => {
    const captured: Array<{ base: string | null; suffix: string; wait: boolean }> = [];
    _internals.mergeInline = async (
      _t: string,
      _s: string,
      base: string | null = null,
      options: { suffix?: string; wait?: boolean } = {},
    ) => {
      captured.push({ base, suffix: options.suffix ?? ".txt", wait: options.wait ?? false });
      return null;
    };
    await main(["mine", "theirs", "base", "--suffix", ".py", "--wait"]);
    expect(captured[0]).toEqual({ base: "base", suffix: ".py", wait: true });
  });

  test("outside JetBrains -> 1 before work", async () => {
    _internals.inIdea = () => false;
    let reached = false;
    _internals.mergeInline = async () => {
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

  test.each([[[]], [["only"]], [["a", "b", "c", "d"]]])("wrong arg count %p -> exit 2", async (argv) => {
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      await expect(main(argv)).rejects.toThrow("exit:2");
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("usage: merge_inline.py");
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
