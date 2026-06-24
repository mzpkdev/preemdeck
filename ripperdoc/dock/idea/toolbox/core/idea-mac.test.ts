/**
 * idea-mac.test.ts — hermetic, no real `ps` or IDE. Port of test_mac.py with the
 * SAME live-captured WebStorm ancestry fixture.
 *
 * MOCK PATTERN A — dependency injection: resolveExecPath() takes a `probe` and a
 * `startPid` seam, so the ancestry walk is driven by a canned dict instead of
 * spawning `ps` (the Python suite monkeypatched `idea_mac.subprocess.run` +
 * `os.getpid`). The probe seam is async (production reads `ps` via `Bun.spawn`),
 * so the fake returns a resolved Promise. resolveLogDir() takes a `resolveExec`
 * seam and is exercised against a fake JetBrains log tree under a tmp HOME, with
 * mtimes set so the newest matching product dir wins (MOCK PATTERN E — real tmp FS).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdeaError } from "./errors.ts";
import { inIdea, type PsProbe, resolveExecPath, resolveLogDir } from "./idea-mac.ts";

const WEBSTORM = "/Applications/WebStorm.app/Contents/MacOS/webstorm";

// Real ancestry observed under WebStorm: pid -> (ppid, exe).
// The leaf is Python.app (also a .app/Contents/MacOS path) and must be skipped.
const ANCESTRY: Record<number, [number, string]> = {
  7539: [
    7537,
    "/opt/homebrew/Cellar/python@3.14/3.14.5/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python",
  ],
  7537: [81159, "/bin/zsh"],
  81159: [24643, "claude"],
  24643: [57130, "/bin/zsh"],
  57130: [1, WEBSTORM],
};

// A chain with no JetBrains binary: zsh -> launchd -> pid 1.
const NO_IDE: Record<number, [number, string]> = {
  4242: [4241, "/bin/zsh"],
  4241: [1, "/sbin/launchd"],
};

/** Build a PsProbe keyed off the pid, like the Python `_fake_ps` (async seam). */
const fakeProbe = (ancestry: Record<number, [number, string]>): PsProbe => {
  return async (pid) => {
    const entry = ancestry[pid];
    if (entry === undefined) {
      return null; // unknown pid -> ps yields <2 fields -> break (Python parity)
    }
    return { ppid: entry[0], exe: entry[1] };
  };
};

describe("inIdea", () => {
  const saved = { bundle: process.env.__CFBundleIdentifier, term: process.env.TERMINAL_EMULATOR };
  afterEach(() => {
    // Restore the real env after each toggle.
    if (saved.bundle === undefined) delete process.env.__CFBundleIdentifier;
    else process.env.__CFBundleIdentifier = saved.bundle;
    if (saved.term === undefined) delete process.env.TERMINAL_EMULATOR;
    else process.env.TERMINAL_EMULATOR = saved.term;
  });

  test("true via the JetBrains bundle id", () => {
    process.env.__CFBundleIdentifier = "com.jetbrains.WebStorm";
    delete process.env.TERMINAL_EMULATOR;
    expect(inIdea()).toBe(true);
  });

  test("true via the JediTerm terminal emulator", () => {
    delete process.env.__CFBundleIdentifier;
    process.env.TERMINAL_EMULATOR = "JetBrains-JediTerm";
    expect(inIdea()).toBe(true);
  });

  test("false when neither is set", () => {
    delete process.env.__CFBundleIdentifier;
    delete process.env.TERMINAL_EMULATOR;
    expect(inIdea()).toBe(false);
  });
});

describe("resolveExecPath", () => {
  test("walks the ancestry to WebStorm", async () => {
    expect(await resolveExecPath(fakeProbe(ANCESTRY), 7539)).toBe(WEBSTORM);
  });

  test("skips the Python.app ancestor", async () => {
    expect(await resolveExecPath(fakeProbe(ANCESTRY), 7539)).not.toContain("Python.app");
  });

  test("throws IdeaError when no JetBrains binary is in the chain", async () => {
    await expect(resolveExecPath(fakeProbe(NO_IDE), 4242)).rejects.toThrow(IdeaError);
  });

  test("stops the climb at a dead/exited pid (probe returns null)", async () => {
    // A probe that always reports "no such process" -> no IDE found -> IdeaError.
    await expect(resolveExecPath(async () => null, 999)).rejects.toThrow(IdeaError);
  });
});

describe("resolveLogDir", () => {
  let home = "";
  const savedHome = process.env.HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "preemdeck-logdir-"));
    process.env.HOME = home;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    await rm(home, { recursive: true, force: true });
  });

  test("picks the active product's newest-version dir", async () => {
    const base = join(home, "Library/Logs/JetBrains");
    const newest = join(base, "WebStorm2025.3");
    const older = join(base, "WebStorm2025.1");
    const other = join(base, "PyCharm2024.3");
    for (const d of [newest, older, other]) await mkdir(d, { recursive: true });
    // mtimes: WebStorm2025.3 newest of its product; PyCharm is newer still but wrong product.
    await utimes(older, 1000, 1000);
    await utimes(newest, 2000, 2000);
    await utimes(other, 3000, 3000);

    expect(await resolveLogDir(() => "/x/WebStorm.app/Contents/MacOS/webstorm")).toBe(newest);
  });

  test("throws IdeaError when no dir matches the running product", async () => {
    // Running product is GoLand, but the only log dir on disk is PyCharm's.
    await mkdir(join(home, "Library/Logs/JetBrains/PyCharm2024.3"), { recursive: true });
    await expect(resolveLogDir(() => "/x/GoLand.app/Contents/MacOS/goland")).rejects.toThrow(IdeaError);
  });

  test("maps the 'idea' binary to the 'intellijidea' log-dir prefix", async () => {
    const base = join(home, "Library/Logs/JetBrains");
    const ij = join(base, "IntelliJIdea2025.2");
    await mkdir(ij, { recursive: true });
    expect(await resolveLogDir(() => "/x/IntelliJ IDEA.app/Contents/MacOS/idea")).toBe(ij);
  });
});
