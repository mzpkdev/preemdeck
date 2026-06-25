/**
 * uninstall.test.ts — bun-test suite for uninstall.ts.
 *
 * spawn seam — override install's `_internals.spawn` (runCli/unregister route
 *   through it) — NOT mock.module on the shared ./lib/proc.ts, which leaks into
 *   lib/proc.test.ts. Captures the exact argv and scripts exit codes/stderr.
 *   Faithful TS equivalent of the original `patch("install.run_cli")`.
 * MOCK PATTERN E — tmp fixture for manifest + overlay FS (the original monkeypatches
 *   uninstall.REPO_ROOT; the TS port threads repoRoot into loadManifestOrExit /
 *   writeManifest / main, so we point those at an mkdtemp dir).
 * MOCK PATTERN F — spyOn(process,"exit") for the bail-out exit codes.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _internals, MANIFEST_SCHEMA, type OverlayRecord } from "./install.ts";
import type { SpawnResult } from "./lib/proc.ts";
import { loadManifestOrExit, main, reverseOverlay, uninstallFor, unregister, writeManifest } from "./uninstall.ts";

// unregister/runCli shell out through install's `_internals.spawn`; override that
// single field (no mock.module on the shared ./lib/proc.ts — it leaks across
// files) and restore it in afterEach.
const spawnCalls: string[][] = [];
const realSpawn = _internals.spawn;
let spawnImpl: (cmd: string[]) => Promise<SpawnResult> = async () => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
});

let dir = "";
const MANIFEST_FILE = ".install-manifest.json";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "preemdeck-uninstall-"));
  spawnCalls.length = 0;
  spawnImpl = async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
  _internals.spawn = (cmd: string[]) => {
    spawnCalls.push(cmd);
    return spawnImpl(cmd);
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  _internals.spawn = realSpawn;
});

function seedManifest(payload: unknown): void {
  writeFileSync(join(dir, MANIFEST_FILE), typeof payload === "string" ? payload : JSON.stringify(payload));
}

function captureExit(fn: () => unknown): { code: number | null; stderr: string } {
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

const silenceLog = () => spyOn(console, "log").mockImplementation(() => {});

// loadManifestOrExit

describe("loadManifestOrExit", () => {
  test("reads a valid manifest", () => {
    const payload = { schema: MANIFEST_SCHEMA, harnesses: { claude: { overlay: [] } } };
    seedManifest(payload);
    expect(loadManifestOrExit(dir)).toEqual(payload);
  });

  test("missing -> exit 1", () => {
    const { code, stderr } = captureExit(() => loadManifestOrExit(dir));
    expect(code).toBe(1);
    expect(stderr).toContain("nothing to uninstall");
  });

  test("bad schema -> exit 1", () => {
    seedManifest({ schema: 2, harnesses: { claude: {} } });
    expect(captureExit(() => loadManifestOrExit(dir)).code).toBe(1);
  });
});

// reverseOverlay

describe("reverseOverlay", () => {
  test("restores from a backup", () => {
    const dst = join(dir, "settings.json");
    const bak = join(dir, "settings.json.bak");
    writeFileSync(dst, "overlay-content");
    writeFileSync(bak, "user-original");
    const records: OverlayRecord[] = [{ dst, src: "root/claude/settings.json", backup: bak, action: "overwrite" }];
    const logSpy = silenceLog();
    try {
      expect(reverseOverlay(records, false)).toEqual([1, 0]);
    } finally {
      logSpy.mockRestore();
    }
    expect(readFileSync(dst, "utf8")).toBe("user-original");
    expect(existsSync(bak)).toBe(false);
  });

  test("deletes when there is no backup", () => {
    const dst = join(dir, "fixer.md");
    writeFileSync(dst, "overlay-created");
    const records: OverlayRecord[] = [{ dst, src: "root/claude/fixer.md", backup: null, action: "create" }];
    const logSpy = silenceLog();
    try {
      expect(reverseOverlay(records, false)).toEqual([0, 1]);
    } finally {
      logSpy.mockRestore();
    }
    expect(existsSync(dst)).toBe(false);
  });

  test("tolerates an already-gone file", () => {
    const dst = join(dir, "gone.md");
    const records: OverlayRecord[] = [{ dst, src: "root/claude/gone.md", backup: null, action: "create" }];
    const logSpy = silenceLog();
    try {
      expect(reverseOverlay(records, false)).toEqual([0, 0]);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("dry-run counts intent but writes nothing", () => {
    const dst = join(dir, "fixer.md");
    writeFileSync(dst, "overlay-created");
    const records: OverlayRecord[] = [{ dst, src: "root/claude/fixer.md", backup: null, action: "create" }];
    const logSpy = silenceLog();
    try {
      expect(reverseOverlay(records, true)).toEqual([0, 1]);
    } finally {
      logSpy.mockRestore();
    }
    expect(existsSync(dst)).toBe(true);
  });

  test("processes records in REVERSE order", () => {
    const a = join(dir, "a.md");
    const b = join(dir, "b.md");
    writeFileSync(a, "a");
    writeFileSync(b, "b");
    const records: OverlayRecord[] = [
      { dst: a, src: "root/claude/a.md", backup: null, action: "create" },
      { dst: b, src: "root/claude/b.md", backup: null, action: "create" },
    ];
    const lines: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(((line?: unknown) => {
      lines.push(String(line ?? ""));
    }) as never);
    try {
      reverseOverlay(records, false);
    } finally {
      logSpy.mockRestore();
    }
    const removed = lines.filter((l) => l.includes("removed")).map((l) => (l.includes("b.md") ? "b.md" : "a.md"));
    expect(removed).toEqual(["b.md", "a.md"]);
  });
});

// unregister (command shapes via the spawn mock)

describe("unregister", () => {
  test("gemini uses extensions uninstall", async () => {
    const logSpy = silenceLog();
    try {
      const record = { plugins: [{ host: "gemini", rack: "dock", name: "fixer" }], marketplaces: [] };
      expect(await unregister("gemini", record, false)).toEqual([1, 0]);
      expect(spawnCalls).toEqual([["gemini", "extensions", "uninstall", "fixer"]]);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("claude unregisters plugin then marketplace by NAME", async () => {
    const logSpy = silenceLog();
    try {
      const record = {
        plugins: [{ host: "claude", rack: "dock", name: "fixer" }],
        marketplaces: ["dock"],
      };
      expect(await unregister("claude", record, false)).toEqual([1, 1]);
      expect(spawnCalls).toContainEqual(["claude", "plugin", "uninstall", "fixer"]);
      expect(spawnCalls).toContainEqual(["claude", "plugin", "marketplace", "remove", "dock"]);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("gemini skips marketplaces", async () => {
    const logSpy = silenceLog();
    try {
      const record = { plugins: [], marketplaces: ["dock"] };
      expect(await unregister("gemini", record, false)).toEqual([0, 0]);
      expect(spawnCalls).toEqual([]);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("tolerates 'not found' as already-done", async () => {
    spawnImpl = async () => ({ exitCode: 1, stdout: "", stderr: "plugin not found", timedOut: false });
    const logSpy = silenceLog();
    try {
      const record = { plugins: [{ host: "claude", rack: "dock", name: "fixer" }], marketplaces: [] };
      const [pluginsDone] = await unregister("claude", record, false);
      expect(pluginsDone).toBe(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("dry-run runs nothing but counts intent", async () => {
    const logSpy = silenceLog();
    try {
      const record = {
        plugins: [{ host: "claude", rack: "dock", name: "fixer" }],
        marketplaces: ["dock"],
      };
      expect(await unregister("claude", record, true)).toEqual([1, 1]);
      expect(spawnCalls).toEqual([]);
    } finally {
      logSpy.mockRestore();
    }
  });
});

// writeManifest (uninstall's manifest mutation)

describe("writeManifest", () => {
  test("rewrites when harnesses remain", () => {
    const manifest = { schema: MANIFEST_SCHEMA, harnesses: { gemini: { overlay: [] } } };
    const logSpy = silenceLog();
    try {
      writeManifest(dir, manifest, false);
    } finally {
      logSpy.mockRestore();
    }
    const data = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"));
    expect(new Set(Object.keys(data.harnesses))).toEqual(new Set(["gemini"]));
  });

  test("deletes the file when empty", () => {
    seedManifest({ schema: MANIFEST_SCHEMA, harnesses: {} });
    writeManifest(dir, { schema: MANIFEST_SCHEMA, harnesses: {} }, false);
    expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false);
  });

  test("dry-run never writes", () => {
    const logSpy = silenceLog();
    try {
      writeManifest(dir, { schema: MANIFEST_SCHEMA, harnesses: { gemini: {} } }, true);
    } finally {
      logSpy.mockRestore();
    }
    expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false);
  });
});

// uninstallFor — skip path

describe("uninstallFor", () => {
  test("skips a harness absent from the manifest", async () => {
    const lines: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation(((l?: unknown) => {
      lines.push(String(l ?? ""));
    }) as never);
    try {
      await uninstallFor("codex", { schema: MANIFEST_SCHEMA, harnesses: {} }, false);
    } finally {
      logSpy.mockRestore();
    }
    expect(lines.join("\n")).toContain("codex: not present in manifest");
    expect(spawnCalls).toEqual([]);
  });
});

// main (end-to-end manifest mutation)

describe("main", () => {
  test("drops the last harness and removes the file", async () => {
    const dst = join(dir, "settings.json");
    writeFileSync(dst, "overlay");
    seedManifest({
      schema: MANIFEST_SCHEMA,
      harnesses: {
        claude: {
          overlay: [{ dst, src: "root/claude/settings.json", backup: null, action: "create" }],
          marketplaces: [],
          plugins: [],
        },
      },
    });
    const logSpy = silenceLog();
    try {
      const rc = await main(["claude"], dir);
      expect(rc).toBe(0);
      expect(existsSync(dst)).toBe(false);
      expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("drops one harness but keeps the others", async () => {
    seedManifest({
      schema: MANIFEST_SCHEMA,
      harnesses: {
        claude: { overlay: [], marketplaces: [], plugins: [] },
        gemini: { overlay: [], marketplaces: [], plugins: [] },
      },
    });
    const logSpy = silenceLog();
    try {
      const rc = await main(["claude"], dir);
      expect(rc).toBe(0);
      const data = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"));
      expect(new Set(Object.keys(data.harnesses))).toEqual(new Set(["gemini"]));
    } finally {
      logSpy.mockRestore();
    }
  });

  test("dry-run leaves the manifest intact", async () => {
    seedManifest({
      schema: MANIFEST_SCHEMA,
      harnesses: { claude: { overlay: [], marketplaces: [], plugins: [] } },
    });
    const logSpy = silenceLog();
    try {
      const rc = await main(["claude", "--dry-run"], dir);
      expect(rc).toBe(0);
      const data = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"));
      expect(new Set(Object.keys(data.harnesses))).toEqual(new Set(["claude"]));
    } finally {
      logSpy.mockRestore();
    }
  });
});
