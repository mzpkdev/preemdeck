/**
 * update.test.ts — bun-test suite for update.ts.
 *
 * MOCK PATTERN E — tmp fixture: `installedHarnesses` reads the manifest from a
 *   repoRoot we control (the original tests monkeypatch update.REPO_ROOT; the TS
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
import { _internals, CONFIG_FILE, MANIFEST_SCHEMA } from "./install.ts";
import type { SpawnResult } from "./lib/proc.ts";
import {
  gitPull,
  installedHarnesses,
  parseUpdateArgs,
  pickVersion,
  readVersion,
  resolveTarget,
  syncTo,
} from "./update.ts";

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
      expect(out).toContain("(dry-run) would run: git -C /some/repo fetch --depth 1 origin && git reset --hard @{u}");
    } finally {
      logSpy.mockRestore();
    }
    expect(spawnCalls).toEqual([]);
  });

  test("non-dry-run fetches + hard-resets onto the upstream (orphan-tolerant)", async () => {
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    try {
      await gitPull("/some/repo", false);
      expect(spawnCalls).toEqual([
        ["git", "-C", "/some/repo", "fetch", "--depth", "1", "origin"],
        ["git", "-C", "/some/repo", "reset", "--hard", "@{u}"],
      ]);
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

describe("resolveTarget", () => {
  test("channels map to dist-* branches (track)", () => {
    expect(resolveTarget("stable")).toMatchObject({ mode: "track", ref: "dist-stable" });
    expect(resolveTarget("edge")).toMatchObject({ mode: "track", ref: "dist-edge" });
  });

  test("semver pins to a v-tag (frozen)", () => {
    expect(resolveTarget("2.2.1")).toMatchObject({ mode: "pin", ref: "v2.2.1" });
    expect(resolveTarget("v2.2.1")).toMatchObject({ mode: "pin", ref: "v2.2.1" });
  });

  test("other strings track as a raw ref", () => {
    expect(resolveTarget("my-feature")).toMatchObject({ mode: "track", ref: "my-feature" });
  });

  test("absent/empty -> current branch", () => {
    expect(resolveTarget(undefined).mode).toBe("current");
    expect(resolveTarget("   ").mode).toBe("current");
  });
});

describe("readVersion", () => {
  test("reads version from preemdeck.json", async () => {
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ version: "edge" }));
    expect(await readVersion(dir)).toBe("edge");
  });

  test("undefined when file or key missing", async () => {
    expect(await readVersion(dir)).toBeUndefined();
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ directive: {} }));
    expect(await readVersion(dir)).toBeUndefined();
  });
});

describe("syncTo", () => {
  test("track: fetch into remote-tracking + checkout -B", async () => {
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    try {
      await syncTo("/r", { mode: "track", ref: "dist-edge", label: "edge" }, false);
      expect(spawnCalls).toEqual([
        ["git", "-C", "/r", "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
        ["git", "-C", "/r", "fetch", "--depth", "1", "origin", "dist-edge"],
        ["git", "-C", "/r", "checkout", "-B", "dist-edge", "origin/dist-edge"],
      ]);
    } finally {
      outSpy.mockRestore();
    }
  });

  test("pin: fetch tag + detached checkout", async () => {
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    try {
      await syncTo("/r", { mode: "pin", ref: "v2.2.1", label: "pinned v2.2.1" }, false);
      expect(spawnCalls).toEqual([
        ["git", "-C", "/r", "fetch", "--depth", "1", "origin", "tag", "v2.2.1"],
        ["git", "-C", "/r", "checkout", "v2.2.1"],
      ]);
    } finally {
      outSpy.mockRestore();
    }
  });

  test("current: fetches + hard-resets onto the upstream", async () => {
    const outSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    try {
      await syncTo("/r", { mode: "current", ref: "", label: "current branch" }, false);
      expect(spawnCalls).toEqual([
        ["git", "-C", "/r", "fetch", "--depth", "1", "origin"],
        ["git", "-C", "/r", "reset", "--hard", "@{u}"],
      ]);
    } finally {
      outSpy.mockRestore();
    }
  });

  test("dry-run track prints intent, runs nothing", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await syncTo("/r", { mode: "track", ref: "dist-edge", label: "edge" }, true);
    } finally {
      logSpy.mockRestore();
    }
    expect(spawnCalls).toEqual([]);
  });
});

describe("pickVersion", () => {
  test("PREEMDECK_CHANNEL env overrides config version", () => {
    expect(pickVersion("edge", "stable")).toBe("edge");
  });

  test("blank/unset env falls through to config", () => {
    expect(pickVersion(undefined, "stable")).toBe("stable");
    expect(pickVersion("   ", "stable")).toBe("stable");
  });

  test("both unset -> undefined (current branch)", () => {
    expect(pickVersion(undefined, undefined)).toBeUndefined();
  });
});
