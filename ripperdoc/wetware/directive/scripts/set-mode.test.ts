/**
 * set-mode.test.ts — Tmp-fixture FS; the exit-code path is exercised through
 * main() (which returns the code rather than exiting).
 * stderr is captured by spying process.stderr.write (MOCK PATTERN B-style).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { glob, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableModes, configSlots, ModesError, main, setDirective, slotFor } from "./set-mode.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "preemdeck-setmode-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const writeSkill = async (skillsDir: string, name: string) => {
  await mkdir(join(skillsDir, name), { recursive: true });
  await writeFile(join(skillsDir, name, "directive.md"), "body\n");
};
const captureStderr = (): { restore: () => void; text: () => string } => {
  let buf = "";
  const spy = spyOn(process.stderr, "write").mockImplementation(((c: string) => {
    buf += c;
    return true;
  }) as never);
  return { restore: () => spy.mockRestore(), text: () => buf };
};

describe("availableModes", () => {
  test("lists skill folders that ship a directive.md (sorted)", async () => {
    const d = join(dir, "skills");
    for (const n of ["swarm", "ask"]) await writeSkill(d, n);
    expect(await availableModes(d)).toEqual(["ask", "swarm"]);
  });
  test("empty when the dir is missing", async () => {
    expect(await availableModes(join(dir, "nope"))).toEqual([]);
  });
  test("ignores dirs without a directive.md", async () => {
    const d = join(dir, "skills");
    await writeSkill(d, "swarm");
    await mkdir(join(d, "default"));
    expect(await availableModes(d)).toEqual(["swarm"]);
  });
});

describe("slotFor", () => {
  async function modes(map: Record<string, unknown>): Promise<string> {
    const p = join(dir, "modes.json");
    await writeFile(p, JSON.stringify(map));
    return p;
  }
  test("reads the slot from modes.json", async () => {
    const m = await modes({ swarm: "strategy", ask: "discretion" });
    expect(await slotFor(m, "swarm")).toBe("strategy");
    expect(await slotFor(m, "ask")).toBe("discretion");
  });
  test("null when the value is absent", async () => {
    expect(await slotFor(await modes({ ask: "discretion" }), "swarm")).toBeNull();
  });
  test("null when the slot is blank", async () => {
    expect(await slotFor(await modes({ swarm: "   " }), "swarm")).toBeNull();
  });
  test("throws when modes.json is missing", async () => {
    await expect(slotFor(join(dir, "nope.json"), "swarm")).rejects.toThrow(ModesError);
  });
  test("throws when modes.json is malformed", async () => {
    const p = join(dir, "modes.json");
    await writeFile(p, "{bad");
    await expect(slotFor(p, "swarm")).rejects.toThrow(ModesError);
  });
});

describe("configSlots", () => {
  async function cfg(text: string): Promise<string> {
    const p = join(dir, "preemdeck.json");
    await writeFile(p, text);
    return p;
  }
  test("lists the directive object keys (insertion order)", async () => {
    expect(await configSlots(await cfg('{"directive":{"strategy":"x","discretion":"y"}}'))).toEqual([
      "strategy",
      "discretion",
    ]);
  });
  test("empty when missing", async () => {
    expect(await configSlots(await cfg('{"other":1}'))).toEqual([]);
  });
  test("empty for the legacy string form", async () => {
    expect(await configSlots(await cfg('{"directive":"swarm"}'))).toEqual([]);
  });
  test("empty when malformed", async () => {
    expect(await configSlots(await cfg("{bad"))).toEqual([]);
  });
});

describe("setDirective", () => {
  async function cfg(text: string): Promise<string> {
    const p = join(dir, "preemdeck.json");
    await writeFile(p, text);
    return p;
  }
  test("sets the slot and preserves the others + top-level keys", async () => {
    const p = await cfg('{\n  "directive": {"strategy": "", "discretion": "ask"},\n  "other": 1\n}\n');
    await setDirective(p, "strategy", "swarm");
    expect(JSON.parse(await readFile(p, "utf8"))).toEqual({
      directive: { strategy: "swarm", discretion: "ask" },
      other: 1,
    });
  });
  test("creates the object when missing", async () => {
    const p = await cfg('{"keep":true}');
    await setDirective(p, "strategy", "swarm");
    expect(JSON.parse(await readFile(p, "utf8"))).toEqual({ keep: true, directive: { strategy: "swarm" } });
  });
  test("adds a new slot preserving the existing", async () => {
    const p = await cfg('{"directive":{"strategy":"swarm"}}');
    await setDirective(p, "discretion", "auto");
    expect(JSON.parse(await readFile(p, "utf8"))).toEqual({ directive: { strategy: "swarm", discretion: "auto" } });
  });
  test("fixed 2-space framing with trailing newline", async () => {
    const p = await cfg("{}");
    await setDirective(p, "strategy", "swarm");
    expect(await readFile(p, "utf8")).toBe('{\n  "directive": {\n    "strategy": "swarm"\n  }\n}\n');
  });
  test("idempotent rewrite", async () => {
    const p = await cfg('{"directive":{"strategy":"swarm"}}');
    await setDirective(p, "strategy", "swarm");
    const first = await readFile(p, "utf8");
    await setDirective(p, "strategy", "swarm");
    expect(await readFile(p, "utf8")).toBe(first);
  });
  test("leaves no .tmp behind", async () => {
    const p = await cfg("{}");
    await setDirective(p, "strategy", "swarm");
    const leftovers: string[] = [];
    for await (const f of glob("*.tmp", { cwd: dir })) leftovers.push(f);
    expect(leftovers).toEqual([]);
  });
});

describe("main", () => {
  async function setup(
    opts: { configText?: string | null } = {},
  ): Promise<{ cfg: string; skills: string; modes: string }> {
    const skills = join(dir, "skills");
    for (const n of ["swarm", "ask", "auto"]) await writeSkill(skills, n);
    const modes = join(dir, "modes.json");
    await writeFile(modes, JSON.stringify({ swarm: "strategy", ask: "discretion", auto: "discretion" }));
    const cfg = join(dir, "preemdeck.json");
    const text = opts.configText === undefined ? '{"directive": {"strategy": "", "discretion": ""}}' : opts.configText;
    if (text !== null) await writeFile(cfg, text);
    return { cfg, skills, modes };
  }
  const opts = (s: { cfg: string; skills: string; modes: string }) => ({
    searchStart: dir,
    skillsDir: s.skills,
    modesFile: s.modes,
  });

  test("a value derives the strategy slot", async () => {
    const s = await setup();
    expect(await main(["swarm"], opts(s))).toBe(0);
    expect(JSON.parse(await readFile(s.cfg, "utf8")).directive).toEqual({ strategy: "swarm", discretion: "" });
  });
  test("a value derives the discretion slot", async () => {
    const s = await setup();
    expect(await main(["ask"], opts(s))).toBe(0);
    expect(JSON.parse(await readFile(s.cfg, "utf8")).directive).toEqual({ strategy: "", discretion: "ask" });
  });
  test("preserves the other slot + top-level keys", async () => {
    const s = await setup({ configText: '{"directive": {"strategy": "swarm", "discretion": ""}, "other": 1}' });
    expect(await main(["auto"], opts(s))).toBe(0);
    expect(JSON.parse(await readFile(s.cfg, "utf8"))).toEqual({
      directive: { strategy: "swarm", discretion: "auto" },
      other: 1,
    });
  });
  test("idempotent rewrite", async () => {
    const s = await setup();
    expect(await main(["swarm"], opts(s))).toBe(0);
    const first = await readFile(s.cfg, "utf8");
    expect(await main(["swarm"], opts(s))).toBe(0);
    expect(await readFile(s.cfg, "utf8")).toBe(first);
  });
  test("unknown value -> 2 without writing", async () => {
    const s = await setup();
    const err = captureStderr();
    try {
      expect(await main(["bogus"], opts(s))).toBe(2);
      expect(err.text()).toContain("value");
    } finally {
      err.restore();
    }
    expect(JSON.parse(await readFile(s.cfg, "utf8")).directive).toEqual({ strategy: "", discretion: "" });
  });
  test("valid mode missing from modes.json -> 2 without writing", async () => {
    const s = await setup();
    await writeFile(s.modes, JSON.stringify({ ask: "discretion", auto: "discretion" }));
    const err = captureStderr();
    try {
      expect(await main(["swarm"], opts(s))).toBe(2);
      expect(err.text()).toContain("slot");
    } finally {
      err.restore();
    }
  });
  test("missing modes.json -> 2 without writing", async () => {
    const s = await setup();
    await rm(s.modes);
    const err = captureStderr();
    try {
      expect(await main(["swarm"], opts(s))).toBe(2);
      expect(err.text()).toContain("modes.json");
    } finally {
      err.restore();
    }
  });
  test("malformed modes.json -> 2 without writing", async () => {
    const s = await setup();
    await writeFile(s.modes, "{bad");
    const err = captureStderr();
    try {
      expect(await main(["swarm"], opts(s))).toBe(2);
      expect(err.text()).toContain("modes.json");
    } finally {
      err.restore();
    }
  });
  test("derived slot absent from config -> 2", async () => {
    const s = await setup({ configText: '{"directive": {"discretion": ""}}' });
    const err = captureStderr();
    try {
      expect(await main(["swarm"], opts(s))).toBe(2);
      expect(err.text()).toContain("slot");
    } finally {
      err.restore();
    }
    expect(JSON.parse(await readFile(s.cfg, "utf8")).directive.strategy).toBeUndefined();
  });
  test("wrong arg count -> 2", async () => {
    const s = await setup();
    const err = captureStderr();
    try {
      expect(await main([], opts(s))).toBe(2);
      expect(await main(["swarm", "extra"], opts(s))).toBe(2);
    } finally {
      err.restore();
    }
  });
  test("blank arg -> 2", async () => {
    const s = await setup();
    const err = captureStderr();
    try {
      expect(await main(["   "], opts(s))).toBe(2);
    } finally {
      err.restore();
    }
  });
  test("missing config -> 2", async () => {
    const s = await setup({ configText: null });
    const err = captureStderr();
    try {
      expect(await main(["swarm"], opts(s))).toBe(2);
      expect(err.text()).toContain("not found");
    } finally {
      err.restore();
    }
  });
});
