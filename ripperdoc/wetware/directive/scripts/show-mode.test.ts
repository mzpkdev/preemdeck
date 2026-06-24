/**
 * show-mode.test.ts — Tmp-fixture FS; stdout captured via the injected `write`
 * sink, stderr via a process.stderr spy.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableModes, main } from "./show-mode.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "preemdeck-showmode-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const writeSkill = async (skillsDir: string, name: string, body: string) => {
  await mkdir(join(skillsDir, name), { recursive: true });
  await writeFile(join(skillsDir, name, "directive.md"), `${body}\n`);
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
  test("lists skill folders with a directive.md (sorted)", async () => {
    const d = join(dir, "skills");
    for (const n of ["swarm", "ask"]) await writeSkill(d, n, "body");
    expect(await availableModes(d)).toEqual(["ask", "swarm"]);
  });
});

describe("main", () => {
  let skills = "";
  let out = "";
  const write = (s: string) => {
    out += s;
  };
  beforeEach(async () => {
    skills = join(dir, "skills");
    await mkdir(skills, { recursive: true });
    out = "";
  });

  test("prints the directive verbatim (no framing)", async () => {
    const body = "# Strategy: swarm\n\nOrchestrate — don't do.\n";
    await mkdir(join(skills, "swarm"), { recursive: true });
    await writeFile(join(skills, "swarm", "directive.md"), body);
    expect(await main(["swarm"], skills, write)).toBe(0);
    expect(out).toBe(body);
  });

  test("unknown value -> 2 and lists available modes", async () => {
    await writeSkill(skills, "swarm", "body");
    const err = captureStderr();
    try {
      expect(await main(["nope"], skills, write)).toBe(2);
      expect(err.text()).toContain("swarm");
    } finally {
      err.restore();
    }
  });

  test("wrong arg count -> 2", async () => {
    const err = captureStderr();
    try {
      expect(await main([], skills, write)).toBe(2);
      expect(await main(["swarm", "extra"], skills, write)).toBe(2);
    } finally {
      err.restore();
    }
  });

  test("blank arg -> 2", async () => {
    const err = captureStderr();
    try {
      expect(await main(["   "], skills, write)).toBe(2);
    } finally {
      err.restore();
    }
  });

  test("rejects a ../ escape", async () => {
    await mkdir(join(dir, "secret"));
    await writeFile(join(dir, "secret", "directive.md"), "secret");
    const err = captureStderr();
    try {
      expect(await main(["../secret"], skills, write)).toBe(2);
    } finally {
      err.restore();
    }
  });

  test("rejects a path separator", async () => {
    await mkdir(join(skills, "a", "b"), { recursive: true });
    await writeFile(join(skills, "a", "b", "directive.md"), "nested");
    const err = captureStderr();
    try {
      expect(await main(["a/b"], skills, write)).toBe(2);
    } finally {
      err.restore();
    }
  });
});
