/**
 * boot.test.ts — Tmp-fixture FS (MOCK PATTERN E) for readSource/combinedPersona;
 * DI stdin/write for the envelope.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInjectionHook } from "../../../../lib/inject.ts";
import { combinedPersona, readSource } from "./boot.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "preemdeck-boot-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("readSource", () => {
  test("returns null when both missing", async () => {
    expect(await readSource(dir, "engram.dat", "ENGRAM.md")).toBeNull();
  });

  test("reads the .dat (base64) over the .md", async () => {
    await writeFile(join(dir, "engram.dat"), b64("hello from dat"));
    await writeFile(join(dir, "ENGRAM.md"), "hello from md");
    expect(await readSource(dir, "engram.dat", "ENGRAM.md")).toBe("hello from dat");
  });

  test("reads the .md when the .dat is missing", async () => {
    await writeFile(join(dir, "ENGRAM.md"), "engram content");
    expect(await readSource(dir, "engram.dat", "ENGRAM.md")).toBe("engram content");
  });

  test("decodes base64 .dat content", async () => {
    await writeFile(join(dir, "engram.dat"), b64("persona data here"));
    expect(await readSource(dir, "engram.dat", "ENGRAM.md")).toBe("persona data here");
  });
});

describe("combinedPersona + envelope", () => {
  // Helper: run the same render/emit pipeline main() uses, with injected stdin.
  async function emit(stdinText: string): Promise<string> {
    let out = "";
    const persona = await combinedPersona(dir);
    await runInjectionHook({
      event: "SessionStart",
      stdin: { text: () => Promise.resolve(stdinText) },
      write: (l) => {
        out = l;
      },
      render: () => persona || null,
    });
    return out;
  }

  test("emits {} when there is no content", async () => {
    expect(await emit("{}")).toBe("{}");
  });

  test("includes engram content", async () => {
    await writeFile(join(dir, "ENGRAM.md"), "engram content");
    expect(JSON.parse(await emit("{}")).hookSpecificOutput.additionalContext).toContain("engram content");
  });

  test("includes firmware content", async () => {
    await writeFile(join(dir, "FIRMWARE.md"), "firmware content");
    expect(JSON.parse(await emit("{}")).hookSpecificOutput.additionalContext).toContain("firmware content");
  });

  test("concatenates engram + firmware with a blank line", async () => {
    await writeFile(join(dir, "ENGRAM.md"), "  engram  ");
    await writeFile(join(dir, "FIRMWARE.md"), "  firmware  ");
    expect(await combinedPersona(dir)).toBe("engram\n\nfirmware");
  });

  test("default event is SessionStart", async () => {
    await writeFile(join(dir, "ENGRAM.md"), "content");
    expect(JSON.parse(await emit("{}")).hookSpecificOutput.hookEventName).toBe("SessionStart");
  });

  test("a string hook_event_name from stdin wins", async () => {
    await writeFile(join(dir, "ENGRAM.md"), "content");
    expect(JSON.parse(await emit('{"hook_event_name":"CustomEvent"}')).hookSpecificOutput.hookEventName).toBe(
      "CustomEvent",
    );
  });

  test("invalid stdin falls back to the default event", async () => {
    await writeFile(join(dir, "ENGRAM.md"), "content");
    expect(JSON.parse(await emit("not json")).hookSpecificOutput.hookEventName).toBe("SessionStart");
  });

  test("a non-string hook_event_name falls back to the default", async () => {
    await writeFile(join(dir, "ENGRAM.md"), "content");
    expect(JSON.parse(await emit('{"hook_event_name":42}')).hookSpecificOutput.hookEventName).toBe("SessionStart");
  });
});
