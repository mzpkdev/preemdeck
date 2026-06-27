/**
 * install.test.ts — bun-test suite for install.ts.
 *
 * MOCK PATTERNS:
 *   spawn seam — install.ts routes every shell-out through `_internals.spawn`. We
 *       override that single field (NOT mock.module on the shared ./lib/proc.ts,
 *       which leaks into lib/proc.test.ts across one `bun test` run) so command-
 *       SHAPE assertions capture the exact argv runCli/installPlugin/
 *       registerMarketplace hand to it, and we script exit codes/stderr. This is
 *       the faithful TS equivalent of the original `patch("install.run_cli")`
 *       command-array assertions — one level lower, at the only escaping seam.
 *   E — tmp fixture: real FS in an mkdtemp dir (copyOverlay/writeManifest/loadManifest).
 *   F — spyOn(process,"exit"): exit-code assertions for parseInstallArgs.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  _internals,
  backupPath,
  buildMirror,
  CHECK,
  CONFIG_DIRNAMES,
  CONFIG_FILE,
  configDir,
  copyOverlay,
  CROSS,
  DEFAULT_CONFIG,
  installFor,
  installPlugin,
  isMirroredPrimitive,
  loadManifest,
  MANIFEST_FILE,
  MANIFEST_SCHEMA,
  manifestDir,
  type PluginSpec,
  parseInstallArgs,
  readPluginSpecs,
  refreshMarketplace,
  registerMarketplace,
  runCli,
  seedConfig,
  STAGE_ROOT,
  stampMirror,
  writeManifest,
} from "./install.ts";
import type { SpawnOptions, SpawnResult } from "./lib/proc.ts";

// --- spawn seam -------------------------------------------------------------
// Record every spawn() argv and serve a scripted result. Set `spawnImpl` per
// test (exit code, stderr, throw-on-ENOENT, …); the real spawn is restored in
// afterEach so nothing leaks past this file.
const spawnCalls: string[][] = [];
const realSpawn = _internals.spawn;
const ok: SpawnResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
let spawnImpl: (cmd: string[], options?: SpawnOptions) => Promise<SpawnResult> = async () => ok;

function result(over: Partial<SpawnResult>): SpawnResult {
  return { ...ok, ...over };
}

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "preemdeck-install-"));
  spawnCalls.length = 0;
  spawnImpl = async () => ok; // default: every command succeeds
  _internals.spawn = (cmd: string[], options?: SpawnOptions) => {
    spawnCalls.push(cmd);
    return spawnImpl(cmd, options);
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  _internals.spawn = realSpawn; // never leak the stub past this file
});

// manifestDir

describe("manifestDir", () => {
  test("claude", () => expect(manifestDir("claude")).toBe(".claude-plugin"));
  test("codex", () => expect(manifestDir("codex")).toBe(".agents/plugins"));
});

// seedConfig

describe("seedConfig", () => {
  test("writes preemdeck.json with the built-in defaults when absent", () => {
    seedConfig(dir, false);
    expect(readFileSync(join(dir, CONFIG_FILE), "utf8")).toBe(DEFAULT_CONFIG);
  });

  test("never overwrites an existing preemdeck.json", () => {
    writeFileSync(join(dir, CONFIG_FILE), '{"directive":{"strategy":"solo"}}\n');
    seedConfig(dir, false);
    expect(readFileSync(join(dir, CONFIG_FILE), "utf8")).toBe('{"directive":{"strategy":"solo"}}\n');
  });

  test("dry-run does not write", () => {
    seedConfig(dir, true);
    expect(existsSync(join(dir, CONFIG_FILE))).toBe(false);
  });
});

// configDir

describe("configDir", () => {
  // NOTE: configDir joins os.homedir() (not process.env.HOME). Bun's os.homedir()
  // snapshots $HOME at process startup on POSIX, so a runtime process.env.HOME
  // mutation is NOT observable here (unlike the original's Path.home(), which re-reads
  // os.environ each call). The real CLI never mutates HOME mid-process, and a
  // spawned process WITH HOME set is honored (see the golden-diff harness), so
  // parity holds at the only point that matters. Assert against the live homedir.
  test("joins the per-harness dirname onto the real home", () => {
    const home = homedir();
    expect(configDir("claude")).toBe(join(home, ".claude"));
    expect(configDir("codex")).toBe(join(home, ".codex"));
    expect(configDir("gemini")).toBe(join(home, ".gemini"));
  });

  test("CONFIG_DIRNAMES constant", () => {
    expect(CONFIG_DIRNAMES).toEqual({ claude: ".claude", codex: ".codex", gemini: ".gemini" });
  });
});

// readPluginSpecs

describe("readPluginSpecs", () => {
  function seedMarketplace(payload: unknown): string {
    const md = join(dir, ".claude-plugin");
    mkdirSync(md, { recursive: true });
    writeFileSync(join(md, "marketplace.json"), typeof payload === "string" ? payload : JSON.stringify(payload));
    return dir;
  }

  test("returns empty when no manifest", () => {
    expect(readPluginSpecs(dir)).toEqual([]);
  });

  test("parses names and paths", () => {
    const root = seedMarketplace({
      name: "test",
      plugins: [
        { name: "git", source: "./git" },
        { name: "gh", source: "./gh" },
      ],
    });
    const specs = readPluginSpecs(root);
    expect(specs.map((s) => s.name)).toEqual(["git", "gh"]);
    expect(specs.map((s) => s.sourcePath)).toEqual([join(root, "git"), join(root, "gh")]);
  });

  test("handles empty plugins array", () => {
    expect(readPluginSpecs(seedMarketplace({ name: "test", plugins: [] }))).toEqual([]);
  });

  test("handles malformed json", () => {
    expect(readPluginSpecs(seedMarketplace("not valid json{"))).toEqual([]);
  });

  test("skips entries missing name or source", () => {
    const root = seedMarketplace({
      name: "test",
      plugins: [
        { name: "git", source: "./git" },
        { source: "./orphan" },
        { name: "no-source" },
        { name: "bad-source-type", source: 42 },
      ],
    });
    expect(readPluginSpecs(root).map((s) => s.name)).toEqual(["git"]);
  });

  test("skips disabled plugins (ghost)", () => {
    const root = seedMarketplace({
      name: "test",
      plugins: [
        { name: "git", source: "./git" },
        { name: "ghost", source: "./ghost" },
      ],
    });
    expect(readPluginSpecs(root).map((s) => s.name)).toEqual(["git"]);
  });
});

// isMirroredPrimitive — the file-level allowlist gate

describe("isMirroredPrimitive", () => {
  test("ALLOWS every host-parsed primitive", () => {
    for (const p of [
      "/dock/.claude-plugin/marketplace.json",
      "/dock/idea/.claude-plugin/plugin.json",
      "/dock/.agents/plugins/marketplace.json",
      "/dock/idea/.codex-plugin/plugin.json",
      "/wetware/ghost/.codex-plugin/hooks/hooks.json",
      "/dock/idea/gemini-extension.json",
      "/dock/idea/skills/using/SKILL.md",
      "/wetware/directive/commands/ask.toml",
    ]) {
      expect(isMirroredPrimitive(p)).toBe(true);
    }
  });

  test("EXCLUDES code and non-primitive docs", () => {
    for (const p of [
      "/dock/idea/toolbox/open-file.ts",
      "/dock/idea/toolbox/core/index.ts",
      "/wetware/directive/scripts/inject-mode.ts",
      "/wetware/directive/scripts/modes.json",
      "/wetware/directive/skills/ask/directive.md",
      "/wetware/directive/skills/ask/agents/openai.yaml",
      "/wetware/imprint/README.md",
      "/wetware/imprint/IMPRINT.md",
      "/wetware/imprint/hosts/host_gemini.md",
      "/wetware/ghost/engram.dat",
      "/wetware/ghost/stock/ENGRAM.md",
    ]) {
      expect(isMirroredPrimitive(p)).toBe(false);
    }
  });
});

// buildMirror / stampMirror — primitives-only mirror

// Seed a fixture ripperdoc/ under repoRoot with BOTH allowlisted primitives and a
// representative spread of excluded files (code, docs, data, nested toolbox/scripts).
function seedRipperdoc(repoRoot: string): void {
  const w = (rel: string, body: string) => {
    const p = join(repoRoot, "ripperdoc", rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  };
  // allowlisted primitives
  w("dock/.claude-plugin/marketplace.json", JSON.stringify({ name: "dock", plugins: [{ name: "idea", source: "./idea", version: "0.0.0" }] }));
  w("dock/.agents/plugins/marketplace.json", JSON.stringify({ name: "dock", plugins: [] }));
  w("dock/idea/.claude-plugin/plugin.json", JSON.stringify({ name: "idea", version: "0.0.0" }));
  w("dock/idea/.codex-plugin/plugin.json", JSON.stringify({ name: "idea", version: "0.0.0" }));
  w("dock/idea/.codex-plugin/hooks/hooks.json", JSON.stringify({ hooks: {} }));
  w("dock/idea/gemini-extension.json", JSON.stringify({ name: "idea", version: "0.0.0" }));
  w("dock/idea/skills/using/SKILL.md", "# using");
  w("wetware/directive/commands/swarm.toml", "name = 'swarm'");
  // excluded: code, docs, data, nested dirs
  w("dock/idea/toolbox/open-file.ts", "export const x = 1;");
  w("dock/idea/toolbox/core/index.ts", "export const y = 2;");
  w("dock/idea/scripts/build.ts", "// build");
  w("wetware/directive/skills/ask/directive.md", "# directive");
  w("wetware/directive/skills/ask/agents/openai.yaml", "name: ask");
  w("wetware/directive/scripts/modes.json", JSON.stringify({ modes: [] }));
  w("dock/idea/README.md", "# readme");
  w("wetware/ghost/engram.dat", "binary");
  w("wetware/ghost/stock/ENGRAM.md", "# stock");
  w("wetware/imprint/IMPRINT.md", "# imprint");
  w("wetware/imprint/hosts/host_gemini.md", "# host");
}

function walkRel(root: string): string[] {
  const out: string[] = [];
  const { readdirSync: rd } = require("node:fs");
  for (const e of rd(root, { withFileTypes: true })) {
    const f = join(root, e.name);
    if (e.isDirectory()) {
      out.push(...walkRel(f).map((r) => `${e.name}/${r}`));
    } else {
      out.push(e.name);
    }
  }
  return out;
}

describe("buildMirror", () => {
  test("mirrors ONLY allowlisted primitives — no .ts, no excluded files", () => {
    seedRipperdoc(dir);
    const written = buildMirror(dir, false);

    const stage = join(dir, STAGE_ROOT);
    const all = walkRel(stage).sort();
    // exact allowlist set, with rack-relative structure preserved
    expect(all).toEqual([
      "dock/.agents/plugins/marketplace.json",
      "dock/.claude-plugin/marketplace.json",
      "dock/idea/.claude-plugin/plugin.json",
      "dock/idea/.codex-plugin/hooks/hooks.json",
      "dock/idea/.codex-plugin/plugin.json",
      "dock/idea/gemini-extension.json",
      "dock/idea/skills/using/SKILL.md",
      "wetware/directive/commands/swarm.toml",
    ]);
    // NEVER any executable code
    expect(all.filter((p) => p.endsWith(".ts"))).toEqual([]);
    // every excluded artifact is absent
    for (const gone of ["directive.md", "openai.yaml", "modes.json", "README.md", "engram.dat", "ENGRAM.md", "IMPRINT.md", "host_gemini.md"]) {
      expect(all.some((p) => p.endsWith(gone))).toBe(false);
    }
    // returns absolute paths to everything it wrote
    expect(written.length).toBe(all.length);
    expect(written.every((p) => p.startsWith(join(dir, STAGE_ROOT)))).toBe(true);
  });

  test("rebuilds from scratch — a stale primitive does not survive", () => {
    seedRipperdoc(dir);
    buildMirror(dir, false);
    const stale = join(dir, STAGE_ROOT, "dock", "idea", "skills", "using", "SKILL.md");
    expect(existsSync(stale)).toBe(true);

    // drop the source primitive, rebuild
    rmSync(join(dir, "ripperdoc", "dock", "idea", "skills"), { recursive: true, force: true });
    buildMirror(dir, false);
    expect(existsSync(stale)).toBe(false);
  });

  test("missing ripperdoc/ returns empty", () => {
    expect(buildMirror(dir, false)).toEqual([]);
  });

  test("dry-run writes nothing but reports the would-be set", () => {
    seedRipperdoc(dir);
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const written = buildMirror(dir, true);
      expect(written.length).toBe(8);
    } finally {
      logSpy.mockRestore();
    }
    expect(existsSync(join(dir, STAGE_ROOT))).toBe(false);
  });
});

describe("stampMirror", () => {
  test("sets the version of every versioned manifest to the short HEAD SHA", async () => {
    seedRipperdoc(dir);
    const written = buildMirror(dir, false);
    spawnImpl = async () => result({ stdout: "abc1234\n" });

    await stampMirror(dir, written, false);

    expect(spawnCalls).toContainEqual(["git", "-C", dir, "rev-parse", "--short", "HEAD"]);
    const stage = join(dir, STAGE_ROOT);
    // plugin.json + gemini-extension.json carry a top-level "version" -> stamped
    expect(JSON.parse(readFileSync(join(stage, "dock/idea/.claude-plugin/plugin.json"), "utf8")).version).toBe("abc1234");
    expect(JSON.parse(readFileSync(join(stage, "dock/idea/gemini-extension.json"), "utf8")).version).toBe("abc1234");
    // marketplace.json has NO top-level version, but its nested plugins[].version
    // ARE the per-plugin cache keys — each is stamped to the SHA (no top-level key added).
    const market = JSON.parse(readFileSync(join(stage, "dock/.claude-plugin/marketplace.json"), "utf8"));
    expect(market.version).toBeUndefined();
    expect(market.plugins[0].version).toBe("abc1234");
  });

  test("git failure -> versions unchanged, never throws (fallback)", async () => {
    seedRipperdoc(dir);
    const written = buildMirror(dir, false);
    spawnImpl = async () => result({ exitCode: 128, stderr: "not a git repository" });

    await stampMirror(dir, written, false);

    const v = JSON.parse(readFileSync(join(dir, STAGE_ROOT, "dock/idea/.claude-plugin/plugin.json"), "utf8")).version;
    expect(v).toBe("0.0.0"); // untouched
  });

  test("spawn throw (git missing / not a repo) is swallowed", async () => {
    seedRipperdoc(dir);
    const written = buildMirror(dir, false);
    spawnImpl = async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };

    await stampMirror(dir, written, false); // must not reject

    const v = JSON.parse(readFileSync(join(dir, STAGE_ROOT, "dock/idea/gemini-extension.json"), "utf8")).version;
    expect(v).toBe("0.0.0"); // untouched
  });

  test("dry-run is a no-op (no git spawn, no writes)", async () => {
    seedRipperdoc(dir);
    const written = buildMirror(dir, false);
    spawnCalls.length = 0;
    await stampMirror(dir, written, true);
    expect(spawnCalls).toEqual([]);
  });
});

// runCli

describe("runCli", () => {
  test("dry-run returns success without spawning", async () => {
    expect(await runCli(["echo", "test"], true)).toEqual([true, ""]);
    expect(spawnCalls).toEqual([]);
  });

  test("success on exit 0", async () => {
    spawnImpl = async () => ok;
    expect(await runCli(["claude", "x"], false)).toEqual([true, ""]);
  });

  test("non-zero exit surfaces stderr, then stdout, then a default", async () => {
    spawnImpl = async () => result({ exitCode: 1, stderr: "  boom  " });
    expect(await runCli(["claude", "x"], false)).toEqual([false, "boom"]);
    spawnImpl = async () => result({ exitCode: 1, stdout: "out-only" });
    expect(await runCli(["claude", "x"], false)).toEqual([false, "out-only"]);
    spawnImpl = async () => result({ exitCode: 1 });
    expect(await runCli(["claude", "x"], false)).toEqual([false, "non-zero exit"]);
  });

  test("timeout surfaces 'timed out after 10s'", async () => {
    spawnImpl = async () => result({ exitCode: null, timedOut: true });
    expect(await runCli(["claude", "x"], false)).toEqual([false, "timed out after 10s"]);
  });

  test("ENOENT from spawn -> '<cmd> not on PATH'", async () => {
    spawnImpl = async () => {
      throw Object.assign(new Error("Executable not found in $PATH"), { code: "ENOENT" });
    };
    expect(await runCli(["nonexistent-xyz", "x"], false)).toEqual([false, "nonexistent-xyz not on PATH"]);
  });
});

// registerMarketplace — command shapes

describe("registerMarketplace", () => {
  test("claude invokes the marketplace-add CLI", async () => {
    const [r] = await registerMarketplace("claude", "/some/rack", false);
    expect(r).toBe(true);
    expect(spawnCalls).toEqual([["claude", "plugin", "marketplace", "add", "/some/rack"]]);
  });

  test("codex invokes the marketplace-add CLI", async () => {
    await registerMarketplace("codex", "/some/rack", false);
    expect(spawnCalls).toEqual([["codex", "plugin", "marketplace", "add", "/some/rack"]]);
  });

  test("gemini is a no-op", async () => {
    const [r, msg] = await registerMarketplace("gemini", "/some/rack", false);
    expect([r, msg]).toEqual([true, ""]);
    expect(spawnCalls).toEqual([]);
  });

  test("'already' in stderr is treated as success", async () => {
    spawnImpl = async () => result({ exitCode: 1, stderr: "marketplace already exists" });
    const [r] = await registerMarketplace("claude", "/some/rack", false);
    expect(r).toBe(true);
  });
});

// refreshMarketplace — command shape

describe("refreshMarketplace", () => {
  test("invokes `plugin marketplace update <name>`", async () => {
    await refreshMarketplace("claude", "dock", false);
    expect(spawnCalls).toEqual([["claude", "plugin", "marketplace", "update", "dock"]]);
  });
});

// installPlugin — command shapes

describe("installPlugin", () => {
  const spec: PluginSpec = { name: "format", sourcePath: "/some/rack/format" };

  test("claude uses --scope user", async () => {
    await installPlugin("claude", spec, "chrome", false);
    expect(spawnCalls).toEqual([["claude", "plugin", "install", "format@chrome", "--scope", "user"]]);
  });

  test("codex uses the `add` verb, no --scope flag", async () => {
    await installPlugin("codex", spec, "chrome", false);
    expect(spawnCalls).toEqual([["codex", "plugin", "add", "format@chrome"]]);
  });

  test("gemini uses extensions install --path", async () => {
    await installPlugin("gemini", spec, "chrome", false);
    expect(spawnCalls).toEqual([["gemini", "extensions", "install", "--path", "/some/rack/format"]]);
  });

  test("gemini falls back to `extensions update` when already installed", async () => {
    spawnImpl = async () => result({ exitCode: 1, stderr: "extension already installed" });
    await installPlugin("gemini", spec, "chrome", false);
    expect(spawnCalls).toEqual([
      ["gemini", "extensions", "install", "--path", "/some/rack/format"],
      ["gemini", "extensions", "update", "format"],
    ]);
  });
});

// copyOverlay

function seedOverlay(repoRoot: string, harness = "claude"): void {
  const src = join(repoRoot, "root", harness);
  mkdirSync(join(src, "agents"), { recursive: true });
  writeFileSync(join(src, "settings.json"), '{"_": "overlay"}');
  writeFileSync(join(src, "agents", "fixer.md"), "# fixer overlay");
}

describe("copyOverlay", () => {
  test("create, no backup", () => {
    const repoRoot = join(dir, "repo");
    const config = join(dir, "config");
    seedOverlay(repoRoot);

    const [r, err, records] = copyOverlay("claude", repoRoot, config, false);

    expect([r, err]).toEqual([true, ""]);
    expect(readFileSync(join(config, "settings.json"), "utf8")).toBe('{"_": "overlay"}');
    expect(readFileSync(join(config, "agents", "fixer.md"), "utf8")).toBe("# fixer overlay");
    expect(new Set(records.map((rec) => rec.action))).toEqual(new Set(["create"]));
    expect(records.every((rec) => rec.backup === null)).toBe(true);
    for (const rec of records) {
      expect(rec.src.startsWith("/")).toBe(false); // repo-relative
      expect(rec.dst.startsWith("/")).toBe(true); // absolute
    }
  });

  test("missing root returns empty", () => {
    const repoRoot = join(dir, "repo");
    mkdirSync(repoRoot, { recursive: true });
    const config = join(dir, "config");
    expect(copyOverlay("claude", repoRoot, config, false)).toEqual([true, "", []]);
  });

  test("overwrite backs up the original once at .bak", () => {
    const repoRoot = join(dir, "repo");
    const config = join(dir, "config");
    seedOverlay(repoRoot);
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "settings.json"), '{"_": "user-original"}');

    const [r, err, records] = copyOverlay("claude", repoRoot, config, false);

    expect([r, err]).toEqual([true, ""]);
    expect(readFileSync(join(config, "settings.json.bak"), "utf8")).toBe('{"_": "user-original"}');
    expect(readFileSync(join(config, "settings.json"), "utf8")).toBe('{"_": "overlay"}');
    const rec = records.find((x) => x.dst.endsWith("settings.json"));
    expect(rec?.action).toBe("overwrite");
    expect(rec?.backup).toBe(join(config, "settings.json.bak"));
  });

  test("repeat install skips re-backup for a recorded file", () => {
    const repoRoot = join(dir, "repo");
    const config = join(dir, "config");
    seedOverlay(repoRoot);
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "settings.json"), '{"_": "user-original"}');

    const [, , records1] = copyOverlay("claude", repoRoot, config, false);
    writeManifest(repoRoot, "claude", records1, [], [], false);
    expect(readFileSync(join(config, "settings.json.bak"), "utf8")).toBe('{"_": "user-original"}');

    writeFileSync(join(repoRoot, "root", "claude", "settings.json"), '{"_": "overlay-v2"}');
    const [, , records2] = copyOverlay("claude", repoRoot, config, false);

    expect(readFileSync(join(config, "settings.json"), "utf8")).toBe('{"_": "overlay-v2"}');
    expect(readFileSync(join(config, "settings.json.bak"), "utf8")).toBe('{"_": "user-original"}');
    const rec = records2.find((x) => x.dst.endsWith("settings.json"));
    expect(rec?.backup).toBe(null);
    expect(rec?.action).toBe("overwrite");
  });

  test("second backup uses a timestamp suffix when .bak is taken", () => {
    const repoRoot = join(dir, "repo");
    const config = join(dir, "config");
    seedOverlay(repoRoot);
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "settings.json"), '{"_": "user-original"}');
    writeFileSync(join(config, "settings.json.bak"), '{"_": "stale-bak"}');

    const [, , records] = copyOverlay("claude", repoRoot, config, false);

    expect(readFileSync(join(config, "settings.json.bak"), "utf8")).toBe('{"_": "stale-bak"}');
    const rec = records.find((x) => x.dst.endsWith("settings.json"));
    expect(rec?.backup).toMatch(/settings\.json\.bak\.\d+$/);
    expect(readFileSync(rec?.backup as string, "utf8")).toBe('{"_": "user-original"}');
  });

  test("dry-run writes nothing but still produces records", () => {
    const repoRoot = join(dir, "repo");
    const config = join(dir, "config");
    seedOverlay(repoRoot);
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "settings.json"), '{"_": "user-original"}');

    const [r, err, records] = copyOverlay("claude", repoRoot, config, true);

    expect([r, err]).toEqual([true, ""]);
    expect(readFileSync(join(config, "settings.json"), "utf8")).toBe('{"_": "user-original"}');
    expect(() => readFileSync(join(config, "settings.json.bak"), "utf8")).toThrow();
    expect(records.length).toBe(2);
    const rec = records.find((x) => x.dst.endsWith("settings.json"));
    expect(rec?.action).toBe("overwrite");
    expect(rec?.backup).toBe(join(config, "settings.json.bak"));
  });
});

// backupPath

describe("backupPath", () => {
  test("returns .bak when free, .bak.<ts> when taken", () => {
    const target = join(dir, "x.json");
    expect(backupPath(target)).toBe(`${target}.bak`);
    writeFileSync(`${target}.bak`, "taken");
    expect(backupPath(target)).toMatch(/x\.json\.bak\.\d+$/);
  });
});

// writeManifest

describe("writeManifest", () => {
  test("writes schema + harness record", () => {
    const overlay = [
      { dst: "/c/settings.json", src: "root/claude/settings.json", backup: null, action: "create" as const },
    ];
    writeManifest(dir, "claude", overlay, ["dock"], [{ name: "fixer" }], false);

    const data = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"));
    expect(data.schema).toBe(MANIFEST_SCHEMA);
    expect(Object.keys(data.harnesses)).toEqual(["claude"]);
    expect(data.harnesses.claude.overlay).toEqual(overlay);
    expect(data.harnesses.claude.marketplaces).toEqual(["dock"]);
    expect(data.harnesses.claude.plugins).toEqual([{ name: "fixer" }]);
    expect("installed_at" in data.harnesses.claude).toBe(true);
  });

  test("merges across harnesses", () => {
    writeManifest(dir, "claude", [], ["dock"], [], false);
    writeManifest(dir, "gemini", [], [], [], false);
    const data = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"));
    expect(new Set(Object.keys(data.harnesses))).toEqual(new Set(["claude", "gemini"]));
  });

  test("replaces the same harness", () => {
    writeManifest(dir, "claude", [], ["dock"], [], false);
    writeManifest(dir, "claude", [], ["chrome", "dock"], [], false);
    const data = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"));
    expect(data.harnesses.claude.marketplaces).toEqual(["chrome", "dock"]);
  });

  test("dry-run writes nothing", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      writeManifest(dir, "claude", [], [], [], true);
    } finally {
      logSpy.mockRestore();
    }
    expect(() => readFileSync(join(dir, MANIFEST_FILE), "utf8")).toThrow();
  });

  test("emits 2-space indent + trailing newline (schema-1 shape)", () => {
    writeManifest(dir, "claude", [], [], [], false);
    const text = readFileSync(join(dir, MANIFEST_FILE), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "schema": 1,');
  });
});

// loadManifest

describe("loadManifest", () => {
  test("skeleton when missing", () => {
    expect(loadManifest(dir)).toEqual({ schema: MANIFEST_SCHEMA, harnesses: {} });
  });

  test("skeleton when corrupt", () => {
    writeFileSync(join(dir, MANIFEST_FILE), "not json{");
    expect(loadManifest(dir)).toEqual({ schema: MANIFEST_SCHEMA, harnesses: {} });
  });

  test("reads valid", () => {
    const payload = { schema: 1, harnesses: { claude: { overlay: [] } } };
    writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(payload));
    expect(loadManifest(dir)).toEqual(payload);
  });
});

// installFor — behavior via the spawn mock (harness presence is an `onPath` spawn)

describe("installFor", () => {
  test("returns 1 when the harness is not on PATH", async () => {
    // onPath() shells out to `sh -c command -v` — make that probe fail (exit 1).
    spawnImpl = async (cmd) => (cmd[0] === "sh" ? result({ exitCode: 1 }) : ok);
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const rc = await installFor("claude", false);
      expect(rc).toBe(1);
      const wrote = errSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(wrote).toContain("not on PATH");
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test("dry-run returns 0 (harness present, no real subprocess work)", async () => {
    // onPath probe succeeds; in dry-run copyOverlay/writeManifest write
    // nothing, so this is safe to run against the real REPO_ROOT / $HOME.
    spawnImpl = async () => ok;
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const rc = await installFor("claude", true);
      expect(rc).toBe(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  // NOTE: the marketplace-failure path (-> rc 1) is NOT unit-tested here. With
  // dryRun=false, installFor's copyOverlay writes the real overlay into $HOME and
  // writeManifest writes the real repo's .install-manifest.json — destructive side
  // effects the original test sidesteps via patch("install.copy_overlay"/...), which
  // has no equivalent for install.ts's own self-calls. The path is covered by the
  // golden-diff dry-run and the registerMarketplace unit tests above.
});

// parseInstallArgs — exit-code behavior (MOCK PATTERN F)

describe("parseInstallArgs", () => {
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

  test("parses harness + --dry-run", () => {
    expect(parseInstallArgs(["claude", "--dry-run"])).toEqual({ harness: "claude", dryRun: true });
    expect(parseInstallArgs(["gemini"])).toEqual({ harness: "gemini", dryRun: false });
  });

  test("missing harness -> exit 2", () => {
    const { code, stderr } = captureExit(() => parseInstallArgs([]));
    expect(code).toBe(2);
    expect(stderr).toContain("required: harness");
  });

  test("invalid harness choice -> exit 2", () => {
    const { code, stderr } = captureExit(() => parseInstallArgs(["bogus"]));
    expect(code).toBe(2);
    expect(stderr).toContain("invalid choice: 'bogus'");
  });

  test("unknown option -> exit 2", () => {
    const { code, stderr } = captureExit(() => parseInstallArgs(["claude", "--nope"]));
    expect(code).toBe(2);
    expect(stderr).toContain("install.ts:");
  });
});
