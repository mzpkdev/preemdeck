/**
 * diff-file.test.ts — hermetic port of test_diff_file.py. launch + inIdea +
 * read-back injected via `_internals`; nothing spawns. Inputs are real tmp files
 * so strict resolution behaves like production (a missing input fails fast).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdeaError } from "./core/errors.ts";
import { _internals, diffFile, main } from "./diff-file.ts";

const RECONCILED = "RECONCILED\n";
const real = { inIdea: _internals.inIdea, launch: _internals.launch, readFile: _internals.readFile };
let dir = "";
let calls: Array<{ args: string[]; wait: boolean }>;

const stubLaunch = (writeTo?: string, text = RECONCILED) => {
  return async (args: string[], options: { wait?: boolean } = {}) => {
    const wait = options.wait ?? false;
    calls.push({ args, wait });
    if (wait && writeTo !== undefined) {
      writeFileSync(writeTo, text);
    }
    return {} as unknown as Bun.Subprocess;
  };
};

const makeInputs = (): { target: string; suggestion: string } => {
  const target = join(dir, "target.py");
  const suggestion = join(dir, "suggestion.py");
  writeFileSync(target, "a\n");
  writeFileSync(suggestion, "b\n");
  return { target, suggestion };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "preemdeck-difffile-"));
  calls = [];
  _internals.inIdea = () => true;
  _internals.launch = stubLaunch();
  _internals.readFile = (p: string) => readFileSync(p, { encoding: "utf8" });
});
afterEach(() => {
  _internals.inIdea = real.inIdea;
  _internals.launch = real.launch;
  _internals.readFile = real.readFile;
  rmSync(dir, { recursive: true, force: true });
});

describe("diffFile", () => {
  test("threads resolved paths into argv (diff L R), async by default", async () => {
    const { target, suggestion } = makeInputs();
    await diffFile(target, suggestion);
    expect(calls).toEqual([{ args: ["diff", realpathSync(target), realpathSync(suggestion)], wait: false }]);
    expect(calls[0]?.args).not.toContain("--wait");
  });

  test("2-way wait watches LEFT (target) and returns its edited text", async () => {
    const { target, suggestion } = makeInputs();
    _internals.launch = stubLaunch(realpathSync(target), "AFTER EDIT\n");
    expect(await diffFile(target, suggestion, true)).toBe("AFTER EDIT\n");
    expect(calls[0]?.wait).toBe(true);
  });

  test("wait untouched LEFT returns original", async () => {
    const { target, suggestion } = makeInputs();
    expect(await diffFile(target, suggestion, true)).toBe("a\n");
  });

  test("no-wait returns null, launch wait=false", async () => {
    const { target, suggestion } = makeInputs();
    expect(await diffFile(target, suggestion)).toBeNull();
    expect(calls[0]?.wait).toBe(false);
  });

  test("missing input throws before launch", async () => {
    const { target } = makeInputs();
    await expect(diffFile(target, join(dir, "nope.py"))).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("main", () => {
  test("two files invoke diff, returns 0", async () => {
    const { target, suggestion } = makeInputs();
    expect(await main([target, suggestion])).toBe(0);
    expect(calls).toEqual([{ args: ["diff", realpathSync(target), realpathSync(suggestion)], wait: false }]);
  });

  test("--wait prints LEFT contents", async () => {
    const { target, suggestion } = makeInputs();
    _internals.launch = stubLaunch(realpathSync(target), RECONCILED);
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    try {
      expect(await main([target, suggestion, "--wait"])).toBe(0);
      expect(outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toBe(RECONCILED);
    } finally {
      outSpy.mockRestore();
    }
  });

  test("missing input -> 1", async () => {
    const { target } = makeInputs();
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      expect(await main([target, join(dir, "nope.py")])).toBe(1);
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("diff_file:");
    } finally {
      errSpy.mockRestore();
    }
  });

  test("no live IDE -> 1", async () => {
    _internals.launch = async () => {
      throw new IdeaError("no live IDE");
    };
    const { target, suggestion } = makeInputs();
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      expect(await main([target, suggestion])).toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  test.each([[[]], [["only.py"]], [["a.py", "b.py", "c.py"]]])("wrong arg count %p -> exit 2", async (argv) => {
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      await expect(main(argv)).rejects.toThrow("exit:2");
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("usage: diff_file.py");
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
