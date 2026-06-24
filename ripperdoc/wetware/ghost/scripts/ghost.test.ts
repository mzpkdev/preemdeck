/**
 * ghost.test.ts — Tmp-fixture FS (MOCK PATTERN E); the stdout side is captured
 * via the injected `log` sink rather than spying console.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists } from "../../../../lib/fs.ts";
import { decode, encode, flatline, MAPPINGS, main } from "./ghost.ts";

let dir = "";
const lines: string[] = [];
const log = (l: string) => {
  lines.push(l);
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "preemdeck-ghost-"));
  lines.length = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const decodeDat = async (p: string) => Buffer.from((await readFile(p)).toString("utf8"), "base64").toString("utf8");

describe("encode", () => {
  test("encodes <MD> to base64 <DAT>", async () => {
    await writeFile(join(dir, "ENGRAM.md"), "engram content");
    await encode(dir, log);
    const dat = join(dir, "engram.dat");
    expect(await exists(dat)).toBe(true);
    expect(await decodeDat(dat)).toBe("engram content");
  });

  test("removes the <MD> after encoding", async () => {
    await writeFile(join(dir, "ENGRAM.md"), "engram content");
    await encode(dir, log);
    expect(await exists(join(dir, "ENGRAM.md"))).toBe(false);
  });

  test("skips missing <MD> files", async () => {
    await writeFile(join(dir, "PULSE.md"), "pulse");
    await encode(dir, log);
    expect(await exists(join(dir, "pulse.dat"))).toBe(true);
    expect(await exists(join(dir, "engram.dat"))).toBe(false);
  });

  test("prints the mapping line", async () => {
    await writeFile(join(dir, "FIRMWARE.md"), "fw");
    await encode(dir, log);
    expect(lines).toContain("FIRMWARE.md -> firmware.dat");
  });

  test("encodes all mappings", async () => {
    for (const [mdName] of MAPPINGS) await writeFile(join(dir, mdName), `content of ${mdName}`);
    await encode(dir, log);
    for (const [, datName] of MAPPINGS) expect(await exists(join(dir, datName))).toBe(true);
  });
});

describe("decode", () => {
  test("decodes <DAT> back to <MD>", async () => {
    await writeFile(join(dir, "engram.dat"), b64("engram data"));
    await decode(dir, log);
    const md = join(dir, "ENGRAM.md");
    expect(await exists(md)).toBe(true);
    expect(await readFile(md, "utf8")).toBe("engram data");
  });

  test("skips missing <DAT> files", async () => {
    await writeFile(join(dir, "pulse.dat"), b64("pulse data"));
    await decode(dir, log);
    expect(await exists(join(dir, "PULSE.md"))).toBe(true);
    expect(await exists(join(dir, "ENGRAM.md"))).toBe(false);
  });

  test("prints the mapping line", async () => {
    await writeFile(join(dir, "pulse.dat"), b64("pulse"));
    await decode(dir, log);
    expect(lines).toContain("pulse.dat -> PULSE.md");
  });

  test("does not remove the <DAT> (non-destructive)", async () => {
    await writeFile(join(dir, "engram.dat"), b64("data"));
    await decode(dir, log);
    expect(await exists(join(dir, "engram.dat"))).toBe(true);
  });
});

describe("flatline", () => {
  async function seedStock() {
    await mkdir(join(dir, "stock"));
    for (const [mdName] of MAPPINGS) await writeFile(join(dir, "stock", mdName), `stock ${mdName}`);
  }

  test("restores stock then encodes (dat files exist after)", async () => {
    await seedStock();
    await flatline(dir, log);
    for (const [, datName] of MAPPINGS) expect(await exists(join(dir, datName))).toBe(true);
  });

  test("prints 'persona wiped to stock'", async () => {
    await seedStock();
    await flatline(dir, log);
    expect(lines).toContain("persona wiped to stock");
  });

  test("skips stock <MD> not present", async () => {
    await mkdir(join(dir, "stock"));
    await writeFile(join(dir, "stock", "PULSE.md"), "stock pulse");
    await flatline(dir, log);
    expect(await exists(join(dir, "pulse.dat"))).toBe(true);
    expect(await exists(join(dir, "engram.dat"))).toBe(false);
  });
});

describe("main", () => {
  test("encode command", async () => {
    await writeFile(join(dir, "PULSE.md"), "pulse");
    expect(await main(["encode"], dir, log)).toBe(0);
    expect(await exists(join(dir, "pulse.dat"))).toBe(true);
  });

  test("decode command", async () => {
    await writeFile(join(dir, "pulse.dat"), b64("pulse data"));
    expect(await main(["decode"], dir, log)).toBe(0);
    expect(await exists(join(dir, "PULSE.md"))).toBe(true);
  });

  test("unknown command returns 1", async () => {
    expect(await main(["bogus"], dir, log)).toBe(1);
  });

  test("no command returns 1", async () => {
    expect(await main([], dir, log)).toBe(1);
  });

  test("flatline command returns 0 and prints", async () => {
    await mkdir(join(dir, "stock"));
    expect(await main(["flatline"], dir, log)).toBe(0);
    expect(lines).toContain("persona wiped to stock");
  });
});
