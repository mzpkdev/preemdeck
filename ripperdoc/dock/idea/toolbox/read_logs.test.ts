/**
 * read_logs.test.ts — hermetic port of test_read_logs.py. resolveLogDir + the FS
 * read + inIdea are injected via `_internals` (DI seam). A real tmp idea.log
 * fixture backs the read (contract pattern E).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdeaError } from "./core/_errors.ts";
import { _internals, main, readLogs } from "./read_logs.ts";

const real = { inIdea: _internals.inIdea, resolveLogDir: _internals.resolveLogDir, readFile: _internals.readFile };
let dir = "";
let logSpy: ReturnType<typeof spyOn>;

function writeLog(lines: string[]): void {
  writeFileSync(join(dir, "idea.log"), lines.map((l) => `${l}\n`).join(""));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "preemdeck-readlogs-"));
  _internals.inIdea = () => true;
  _internals.resolveLogDir = () => dir;
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  _internals.inIdea = real.inIdea;
  _internals.resolveLogDir = real.resolveLogDir;
  _internals.readFile = real.readFile;
  logSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

describe("readLogs", () => {
  test("returns the last n lines in order", () => {
    writeLog(["one", "two", "three", "four", "five"]);
    expect(readLogs(3)).toEqual(["three", "four", "five"]);
  });

  test("n larger than file returns all lines", () => {
    writeLog(["alpha", "bravo", "charlie"]);
    expect(readLogs(999)).toEqual(["alpha", "bravo", "charlie"]);
  });

  test("default returns last 50", () => {
    const lines = Array.from({ length: 120 }, (_, i) => `line-${i}`);
    writeLog(lines);
    expect(readLogs()).toEqual(lines.slice(-50));
  });

  test("propagates IdeaError from resolveLogDir", () => {
    _internals.resolveLogDir = () => {
      throw new IdeaError("no IDE");
    };
    expect(() => readLogs(5)).toThrow(IdeaError);
  });
});

describe("main", () => {
  test("no args prints last 50, returns 0", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line-${i}`);
    writeLog(lines);
    expect(main([])).toBe(0);
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toBe(lines.slice(-50).join("\n"));
  });

  test("n arg prints last n joined by newlines", () => {
    writeLog(["a", "b", "c", "d"]);
    expect(main(["3"])).toBe(0);
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toBe("b\nc\nd");
  });

  test("returns 1 on IdeaError, nothing to stdout", () => {
    _internals.resolveLogDir = () => {
      throw new IdeaError("no IDE");
    };
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      expect(main([])).toBe(1);
      expect(logSpy.mock.calls.length).toBe(0);
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("read_logs:");
    } finally {
      errSpy.mockRestore();
    }
  });

  test("outside JetBrains -> 1 before work, never reads", () => {
    _internals.inIdea = () => false;
    _internals.resolveLogDir = () => {
      throw new Error("must not be reached");
    };
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      expect(main([])).toBe(1);
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain(
        "read_logs: no JetBrains IDE in the process ancestry",
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  test("non-int arg -> exit 2 with usage", () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      expect(() => main(["abc"])).toThrow("exit:2");
      const err = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
      expect(err).toContain("usage:");
      expect(err).toContain("invalid int value: 'abc'");
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
