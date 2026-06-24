/**
 * merge-file.test.ts — hermetic tests. launch + inIdea +
 * reaper + read-back injected via `_internals`; nothing spawns. The launch stub
 * returns a fake child whose `.exited` Promise (the native-merge join) writes the
 * OUTPUT (last argv element) — what mergeFile reads back on wait. Inputs are real
 * tmp files (strict resolution).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists } from "../../../../lib/fs.ts";
import { IdeaError } from "./core/errors.ts";
import { _internals, main, mergeFile } from "./merge-file.ts";

const MERGED = "MERGED\n";
const real = {
  inIdea: _internals.inIdea,
  launch: _internals.launch,
  reapLater: _internals.reapLater,
  readFile: _internals.readFile,
};
let dir = "";
let calls: string[][];
let reaped: string[][];

/** launch stub: records argv, returns a fake child whose `.exited` writes `text` to the OUTPUT (last arg). */
const stubLaunch = (text = MERGED) => {
  return async (args: string[]) => {
    calls.push(args);
    const output = args[args.length - 1] as string;
    return {
      exited: Promise.resolve().then(async () => {
        await writeFile(output, text);
        return 0;
      }),
    } as unknown as Bun.Subprocess;
  };
};

const makeInputs = async (): Promise<{ target: string; suggestion: string; base: string }> => {
  const target = join(dir, "target.py");
  const suggestion = join(dir, "suggestion.py");
  const base = join(dir, "base.py");
  await writeFile(target, "a\n");
  await writeFile(suggestion, "b\n");
  await writeFile(base, "o\n");
  return { target, suggestion, base };
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "preemdeck-mergefile-"));
  calls = [];
  reaped = [];
  _internals.inIdea = () => true;
  _internals.launch = stubLaunch();
  _internals.reapLater = (paths: Iterable<string>) => {
    reaped.push([...paths]);
  };
  _internals.readFile = (p: string) => readFile(p, { encoding: "utf8" });
});
afterEach(async () => {
  _internals.inIdea = real.inIdea;
  _internals.launch = real.launch;
  _internals.reapLater = real.reapLater;
  _internals.readFile = real.readFile;
  await rm(dir, { recursive: true, force: true });
});

describe("mergeFile", () => {
  test("no base: argv is [merge, target, suggestion, output], never --wait", async () => {
    const { target, suggestion } = await makeInputs();
    await mergeFile(target, suggestion, null, true);
    const argv = calls[0] as string[];
    expect(argv.slice(0, 3)).toEqual(["merge", await realpath(target), await realpath(suggestion)]);
    expect(argv.length).toBe(4);
    expect(argv).not.toContain("--wait");
  });

  test("with base: base THIRD, output LAST", async () => {
    const { target, suggestion, base } = await makeInputs();
    await mergeFile(target, suggestion, base, true);
    const argv = calls[0] as string[];
    expect(argv.slice(0, 4)).toEqual([
      "merge",
      await realpath(target),
      await realpath(suggestion),
      await realpath(base),
    ]);
    expect(argv.length).toBe(5);
  });

  test("wait joins the process, returns the output, cleans up", async () => {
    const { target, suggestion } = await makeInputs();
    expect(await mergeFile(target, suggestion, null, true)).toBe(MERGED);
    const output = (calls[0] as string[])[3] as string;
    expect(await exists(output)).toBe(false);
  });

  test("no-wait returns null and schedules a reap of the output temp", async () => {
    const { target, suggestion } = await makeInputs();
    expect(await mergeFile(target, suggestion)).toBeNull();
    const output = (calls[0] as string[])[3] as string;
    expect(reaped).toEqual([[output]]);
    if (await exists(output)) await rm(output, { force: true });
  });

  test("missing input throws before launch", async () => {
    const { target } = await makeInputs();
    await expect(mergeFile(target, join(dir, "nope.py"))).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  test("output suffix mirrors the target extension", async () => {
    const { target, suggestion } = await makeInputs();
    await mergeFile(target, suggestion, null, true);
    expect((calls[0] as string[])[3]?.endsWith(".py")).toBe(true);
  });
});

describe("main", () => {
  test("--wait prints the merged result", async () => {
    const { target, suggestion } = await makeInputs();
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    try {
      expect(await main([target, suggestion, "--wait"])).toBe(0);
      expect(outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toBe(MERGED);
    } finally {
      outSpy.mockRestore();
    }
  });

  test("no live IDE -> 1", async () => {
    _internals.launch = async () => {
      throw new IdeaError("no live IDE");
    };
    const { target, suggestion } = await makeInputs();
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      expect(await main([target, suggestion])).toBe(1);
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
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("usage: merge-file");
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
