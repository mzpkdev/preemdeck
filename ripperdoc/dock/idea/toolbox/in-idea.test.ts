/**
 * in-idea.test.ts — hermetic port of test_in_idea.py. The inIdea() detector is
 * injected via `_internals.inIdea` (DI seam, NOT mock.module — which leaks across
 * Bun's single-run suite). Exit-code paths use spyOn(process, "exit") +
 * spyOn(process.stderr,"write) (contract pattern F).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { NotImplementedError } from "./core/errors.ts";
import { _internals, main } from "./in-idea.ts";

const realInIdea = _internals.inIdea;
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  _internals.inIdea = realInIdea;
  logSpy.mockRestore();
});

describe("main", () => {
  test("inside -> prints the line and returns 0", () => {
    _internals.inIdea = () => true;
    expect(main([])).toBe(0);
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toBe("in a JetBrains IDE terminal");
  });

  test("outside -> prints the line and returns 1", () => {
    _internals.inIdea = () => false;
    expect(main([])).toBe(1);
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toBe("not in a JetBrains IDE terminal");
  });

  test("-q is quiet: no output, exit code only", () => {
    _internals.inIdea = () => true;
    expect(main(["-q"])).toBe(0);
    expect(logSpy.mock.calls.length).toBe(0);
  });

  test("-q outside -> 1, no output", () => {
    _internals.inIdea = () => false;
    expect(main(["-q"])).toBe(1);
    expect(logSpy.mock.calls.length).toBe(0);
  });

  test("NotImplementedError (stub platform) -> 1 with note", () => {
    _internals.inIdea = () => {
      throw new NotImplementedError("not implemented for Linux yet");
    };
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      expect(main([])).toBe(1);
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("in_idea:");
    } finally {
      errSpy.mockRestore();
    }
  });

  test("unknown flag -> exit 2 with argparse usage", () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      expect(() => main(["--bogus"])).toThrow("exit:2");
      const err = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
      expect(err).toContain("usage: in_idea.py");
      expect(err).toContain("unrecognized arguments: --bogus");
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
