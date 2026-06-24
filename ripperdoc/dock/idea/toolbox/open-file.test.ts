/**
 * open-file.test.ts — hermetic suite. launch + setPreview + inIdea injected via
 * `_internals` (DI seam); nothing spawns. The wait path reads a real tmp file
 * back; a launch stub models an edit by writing the resolved target (the last
 * argv element).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdeaError } from "./core/errors.ts";
import { _internals, main, openFile } from "./open-file.ts";

const ORIGINAL = "ORIGINAL\n";
const EDITED = "EDITED\n";
const real = {
  inIdea: _internals.inIdea,
  launch: _internals.launch,
  setPreview: _internals.setPreview,
  readFile: _internals.readFile,
};
let dir = "";
let calls: Array<{ args: string[]; wait: boolean }>;

/** A launch stub: records argv + wait, spawns nothing; on wait, optionally writes `edits` to the target. */
const stubLaunch = (edits?: string) => {
  return async (args: string[], options: { wait?: boolean } = {}) => {
    const wait = options.wait ?? false;
    calls.push({ args, wait });
    if (wait && edits !== undefined) {
      await writeFile(args[args.length - 1] as string, edits);
    }
    return { pid: 4321 } as unknown as Bun.Subprocess;
  };
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "preemdeck-openfile-"));
  calls = [];
  _internals.inIdea = () => true;
  _internals.launch = stubLaunch();
  // Read-back uses the real FS (the worker resolves and reads a real tmp file).
  _internals.readFile = (p: string) => readFile(p, { encoding: "utf8" });
});
afterEach(async () => {
  _internals.inIdea = real.inIdea;
  _internals.launch = real.launch;
  _internals.setPreview = real.setPreview;
  _internals.readFile = real.readFile;
  await rm(dir, { recursive: true, force: true });
});

describe("openFile", () => {
  test("fire-and-forget by default: launch wait=false, returns null", async () => {
    const target = join(dir, "thing.py");
    await writeFile(target, ORIGINAL);
    expect(await openFile(target)).toBeNull();
    expect(calls[0]?.wait).toBe(false);
    expect(calls[0]?.args).toEqual(["--line", "1", target]);
  });

  test("threads line + column into argv", async () => {
    const target = join(dir, "thing.py");
    await writeFile(target, ORIGINAL);
    await openFile(target, { line: 42, column: 7 });
    expect(calls[0]?.args).toEqual(["--line", "42", "--column", "7", target]);
  });

  test("wait=true reads the file back (edited)", async () => {
    const target = join(dir, "thing.py");
    await writeFile(target, ORIGINAL);
    _internals.launch = stubLaunch(EDITED);
    expect(await openFile(target, { wait: true })).toBe(EDITED);
    expect(calls[0]?.wait).toBe(true);
  });

  test("wait=true untouched returns original", async () => {
    const target = join(dir, "thing.py");
    await writeFile(target, ORIGINAL);
    expect(await openFile(target, { wait: true })).toBe(ORIGINAL);
  });

  test("preview=true calls setPreview after launch", async () => {
    const target = join(dir, "thing.md");
    await writeFile(target, ORIGINAL);
    const previewed: string[] = [];
    _internals.setPreview = async (p: string) => {
      previewed.push(p);
    };
    await openFile(target, { preview: true });
    expect(previewed.length).toBe(1);
  });
});

describe("main", () => {
  test("no --wait prints nothing, returns 0", async () => {
    const target = join(dir, "thing.py");
    await writeFile(target, ORIGINAL);
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    try {
      expect(await main([target])).toBe(0);
      expect(outSpy.mock.calls.length).toBe(0);
    } finally {
      outSpy.mockRestore();
    }
  });

  test("--wait prints the file contents verbatim", async () => {
    const target = join(dir, "thing.py");
    await writeFile(target, ORIGINAL);
    _internals.launch = stubLaunch(EDITED);
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    try {
      expect(await main([target, "--wait"])).toBe(0);
      expect(outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toBe(EDITED);
    } finally {
      outSpy.mockRestore();
    }
  });

  test("no live IDE -> 1", async () => {
    _internals.launch = async () => {
      throw new IdeaError("no live IDE");
    };
    const target = join(dir, "thing.py");
    await writeFile(target, ORIGINAL);
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      expect(await main([target])).toBe(1);
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("open-file:");
    } finally {
      errSpy.mockRestore();
    }
  });

  test("bad --line -> exit 2", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      await expect(main(["--line", "abc", "foo.txt"])).rejects.toThrow("exit:2");
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("invalid int value: 'abc'");
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
