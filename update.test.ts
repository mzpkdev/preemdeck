/**
 * update.test.ts — bun-test port of tests/test_update.py.
 *
 * MOCK PATTERN E — tmp fixture: `installedHarnesses` reads the manifest from a
 *   repoRoot we control (the Python tests monkeypatch update.REPO_ROOT; the TS
 *   port threads repoRoot as a parameter, so we point it at an mkdtemp dir).
 * spawn seam — override install's `_internals.spawn` (NOT mock.module on the
 *   shared ./lib/proc.ts, which leaks into lib/proc.test.ts) so gitPull never
 *   shells out to a real `git` and we capture the exact argv it would run.
 * MOCK PATTERN F — spyOn(process,"exit") for the bail-out exit codes.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _internals, MANIFEST_SCHEMA } from "./install.ts";
import type { SpawnResult } from "./lib/proc.ts";
import { gitPull, installedHarnesses, parseUpdateArgs } from "./update.ts";

// gitPull shells out through install's `_internals.spawn`; override that single
// field (no mock.module on the shared ./lib/proc.ts — it leaks across files) and
// restore it in afterEach.
const spawnCalls: string[][] = [];
const realSpawn = _internals.spawn;
let spawnImpl: () => Promise<SpawnResult> = async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });

let dir = "";
const MANIFEST_FILE = ".install-manifest.json";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "preemdeck-update-"));
  spawnCalls.length = 0;
  spawnImpl = async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
  _internals.spawn = (cmd: string[]) => {
    spawnCalls.push(cmd);
    return spawnImpl();
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  _internals.spawn = realSpawn;
});

function writeManifest(payload: unknown): void {
  writeFileSync(join(dir, MANIFEST_FILE), typeof payload === "string" ? payload : JSON.stringify(payload));
}

function captureExit(fn: () => void): { code: number | null; stderr: string } {
  let code: number | null = null;
  let stderr = "";
  const exitSpy = spyOn(process, "exit").mockImplementation(((c?: number) => {
    code = c ?? 0;
    throw new Error(`__exit__:${code}`);
  }) as never);
  const errSpy = spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
    stderr += chunk;
    return true;
  }) as never);
  try {
    fn();
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith("__exit__:")) throw e;
  } finally {
    exitSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { code, stderr };
}

describe("installedHarnesses", () => {
  test("returns manifest keys", () => {
    writeManifest({ schema: MANIFEST_SCHEMA, harnesses: { claude: {}, gemini: {} } });
    expect(installedHarnesses(dir).sort()).toEqual(["claude", "gemini"]);
  });

  test("exits 1 when the manifest is missing", () => {
    const { code, stderr } = captureExit(() => installedHarnesses(dir));
    expect(code).toBe(1);
    expect(stderr).toContain("no install manifest");
  });

  test("exits 1 when harnesses is empty", () => {
    writeManifest({ schema: MANIFEST_SCHEMA, harnesses: {} });
    expect(captureExit(() => installedHarnesses(dir)).code).toBe(1);
  });

  test("exits 1 on a bad schema", () => {
    writeManifest({ schema: 2, harnesses: { claude: {} } });
    expect(captureExit(() => installedHarnesses(dir)).code).toBe(1);
  });

  test("exits 1 on corrupt json", () => {
    writeManifest("not json{");
    expect(captureExit(() => installedHarnesses(dir)).code).toBe(1);
  });
});

describe("gitPull", () => {
  test("dry-run prints intent and runs nothing", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await gitPull("/some/repo", true);
      const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("(dry-run) would run: git -C /some/repo pull --ff-only");
    } finally {
      logSpy.mockRestore();
    }
    expect(spawnCalls).toEqual([]);
  });

  test("non-dry-run shells out to git pull --ff-only", async () => {
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    try {
      await gitPull("/some/repo", false);
      expect(spawnCalls).toEqual([["git", "-C", "/some/repo", "pull", "--ff-only"]]);
    } finally {
      outSpy.mockRestore();
    }
  });

  test("non-zero git exit throws (mirrors check=True)", async () => {
    spawnImpl = async () => ({ exitCode: 1, stdout: "", stderr: "not fast-forward", timedOut: false });
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      await expect(gitPull("/some/repo", false)).rejects.toThrow();
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("parseUpdateArgs", () => {
  test("defaults dryRun false; --dry-run flips it", () => {
    expect(parseUpdateArgs([])).toEqual({ dryRun: false });
    expect(parseUpdateArgs(["--dry-run"])).toEqual({ dryRun: true });
  });

  test("unknown option -> exit 2", () => {
    expect(captureExit(() => parseUpdateArgs(["--nope"])).code).toBe(2);
  });
});
