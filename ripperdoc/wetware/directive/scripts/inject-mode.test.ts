/**
 * inject-mode.test.ts — port of test_inject_mode.py. Tmp-fixture FS for the
 * config walk-up + skills dir; DI stdin/write for the envelope.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInjectionHook } from "../../../../lib/inject.ts";
import { extractEvent, findConfig, loadModeText, renderBodies, selectVariants } from "./inject-mode.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "preemdeck-injmode-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const writeCfg = async (text: string): Promise<string> => {
  const p = join(dir, "preemdeck.json");
  await writeFile(p, text);
  return p;
};
const writeSkill = async (skillsDir: string, name: string, body: string) => {
  await mkdir(join(skillsDir, name), { recursive: true });
  await writeFile(join(skillsDir, name, "directive.md"), `${body}\n`);
};

describe("findConfig", () => {
  test("returns null when absent", () => {
    expect(findConfig(dir)).toBeNull();
  });
  test("finds it in the start dir", async () => {
    const cfg = await writeCfg("{}");
    expect(findConfig(dir)).toBe(cfg);
  });
  test("walks up to an ancestor", async () => {
    const cfg = await writeCfg("{}");
    const nested = join(dir, "plugins", "cache", "directive", "scripts");
    await mkdir(nested, { recursive: true });
    expect(findConfig(nested)).toBe(cfg);
  });
  test("the nearest ancestor wins", async () => {
    await writeCfg('{"loc":"far"}');
    const nearDir = join(dir, "a", "b");
    await mkdir(nearDir, { recursive: true });
    const near = join(nearDir, "preemdeck.json");
    await writeFile(near, '{"loc":"near"}');
    expect(findConfig(nearDir)).toBe(near);
  });
});

describe("selectVariants", () => {
  test("object values in slot order", async () => {
    expect(selectVariants(await writeCfg('{"directive":{"strategy":"swarm","discretion":"auto"}}'))).toEqual([
      "swarm",
      "auto",
    ]);
  });
  test("a bare string is a single value", async () => {
    expect(selectVariants(await writeCfg('{"directive":"swarm"}'))).toEqual(["swarm"]);
  });
  test("empty when the field is missing", async () => {
    expect(selectVariants(await writeCfg('{"other":"x"}'))).toEqual([]);
  });
  test("empty when malformed", async () => {
    expect(selectVariants(await writeCfg("{bad json"))).toEqual([]);
  });
  test("empty when the field is the wrong type", async () => {
    expect(selectVariants(await writeCfg('{"directive":42}'))).toEqual([]);
  });
  test("an empty object yields nothing", async () => {
    expect(selectVariants(await writeCfg('{"directive":{}}'))).toEqual([]);
  });
  test("filters blanks/non-strings and dedupes", async () => {
    expect(selectVariants(await writeCfg('{"directive":{"a":"swarm","b":"","c":5,"d":"swarm"}}'))).toEqual(["swarm"]);
  });
});

describe("loadModeText", () => {
  test("loads the directive body (trimmed)", async () => {
    await writeSkill(dir, "swarm", "swarm body");
    expect(loadModeText(dir, "swarm")).toBe("swarm body");
  });
  test("null for unknown", () => {
    expect(loadModeText(dir, "nope")).toBeNull();
  });
  test("null for an empty body", async () => {
    await writeSkill(dir, "blank", "   ");
    expect(loadModeText(dir, "blank")).toBeNull();
  });
  test("rejects path traversal", async () => {
    await mkdir(join(dir, "secret"));
    await writeFile(join(dir, "secret", "directive.md"), "secret");
    expect(loadModeText(join(dir, "skills"), "../secret")).toBeNull();
  });
});

describe("extractEvent", () => {
  test("returns the value after the first --event", () => {
    expect(extractEvent(["--event", "BeforeAgent", "x"])).toBe("BeforeAgent");
  });
  test("null when absent or dangling", () => {
    expect(extractEvent(["x", "y"])).toBeNull();
    expect(extractEvent(["--event"])).toBeNull();
  });
});

describe("main pipeline (renderBodies + envelope)", () => {
  let skillsDir = "";
  beforeEach(() => {
    skillsDir = join(dir, "skills");
  });
  async function emit(opts: { stdin?: string; event?: string } = {}): Promise<string> {
    const cliEvent = opts.event ?? null;
    let out = "";
    await runInjectionHook({
      event: cliEvent ?? undefined,
      stdin: { text: () => Promise.resolve(opts.stdin ?? "{}") },
      write: (l) => {
        out = l;
      },
      render: () => renderBodies(dir, skillsDir),
    });
    return out;
  }

  test("no config is a no-op", async () => {
    await mkdir(skillsDir, { recursive: true });
    expect(await emit()).toBe("{}");
  });

  test("concatenates slots in order", async () => {
    await writeCfg('{"directive":{"strategy":"swarm","discretion":"auto"}}');
    await writeSkill(skillsDir, "swarm", "swarm body");
    await writeSkill(skillsDir, "auto", "auto body");
    await writeSkill(skillsDir, "ask", "ask body");
    expect(JSON.parse(await emit()).hookSpecificOutput.additionalContext).toBe("swarm body\n\nauto body");
  });

  test("a bare string routes a single value", async () => {
    await writeCfg('{"directive":"swarm"}');
    await writeSkill(skillsDir, "swarm", "swarm body");
    await writeSkill(skillsDir, "auto", "auto body");
    expect(JSON.parse(await emit()).hookSpecificOutput.additionalContext).toBe("swarm body");
  });

  test("an unknown value is skipped", async () => {
    await writeCfg('{"directive":{"strategy":"swarm","discretion":"nope"}}');
    await writeSkill(skillsDir, "swarm", "swarm body");
    expect(JSON.parse(await emit()).hookSpecificOutput.additionalContext).toBe("swarm body");
  });

  test("all-unknown is a no-op", async () => {
    await writeCfg('{"directive":{"strategy":"nope"}}');
    await writeSkill(skillsDir, "swarm", "swarm body");
    expect(await emit()).toBe("{}");
  });

  test("an empty object is a no-op", async () => {
    await writeCfg('{"directive":{}}');
    await writeSkill(skillsDir, "swarm", "swarm body");
    expect(await emit()).toBe("{}");
  });

  test("the --event flag is the fallback", async () => {
    await writeCfg('{"directive":{"strategy":"swarm"}}');
    await writeSkill(skillsDir, "swarm", "swarm body");
    expect(JSON.parse(await emit({ event: "BeforeAgent" })).hookSpecificOutput.hookEventName).toBe("BeforeAgent");
  });

  test("a stdin event overrides the flag", async () => {
    await writeCfg('{"directive":{"strategy":"swarm"}}');
    await writeSkill(skillsDir, "swarm", "swarm body");
    const out = await emit({ stdin: '{"hook_event_name":"FromStdin"}', event: "BeforeAgent" });
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("FromStdin");
  });
});
