/**
 * os_notify.test.ts — port of test_os_notify.py. Hermetic: no real banners. The
 * run seam (with env), the terminal-notifier presence check, and the platform
 * worker are injected. The no-injection contract (user text rides env/argv, never
 * the script source) is asserted explicitly, including hostile text.
 */

import { describe, expect, test } from "bun:test";
import { MACOS_APPLESCRIPT, notify, notifyLinux, notifyMacos, platformWorker, runCmd } from "./os_notify.ts";

interface RunCall {
  cmd: string[];
  env: Record<string, string> | undefined;
}
function fakeRun(ok: boolean | ((cmd: string[]) => boolean)): {
  calls: RunCall[];
  run: (cmd: string[], env?: Record<string, string>) => Promise<boolean>;
} {
  const calls: RunCall[] = [];
  const answer = typeof ok === "function" ? ok : () => ok;
  return {
    calls,
    run: (cmd: string[], env?: Record<string, string>) => {
      calls.push({ cmd, env });
      return Promise.resolve(answer(cmd));
    },
  };
}

describe("runCmd — the real (silent) subprocess seam", () => {
  test("false for a missing binary", async () => {
    expect(await runCmd(["preemdeck-no-such-binary-zzz"])).toBe(false);
  });
  test("merges env over the inherited environment (var reaches child)", async () => {
    const code = 'exit $([ "$PD_NOTIFY_TITLE" = X ] && echo 0 || echo 7)';
    expect(await runCmd(["sh", "-c", code], { PD_NOTIFY_TITLE: "X" })).toBe(true);
  });
  test("child keeps the inherited env (PATH survives the merge)", async () => {
    const code = 'exit $([ -n "$PATH" ] && echo 0 || echo 7)';
    expect(await runCmd(["sh", "-c", code], { PD_NOTIFY_TITLE: "X" })).toBe(true);
  });
});

describe("notifyMacos — osascript (env-fed) / terminal-notifier (argv)", () => {
  test("osascript with the static script when terminal-notifier is absent", async () => {
    const f = fakeRun(true);
    expect(await notifyMacos("hello", "CI", { run: f.run, has: () => false })).toBe("osascript");
    expect(f.calls[0]?.cmd).toEqual(["osascript", "-e", MACOS_APPLESCRIPT]);
    expect(f.calls[0]?.env).toEqual({ PD_NOTIFY_TITLE: "CI", PD_NOTIFY_MESSAGE: "hello" });
  });

  test("null when both fail", async () => {
    const f = fakeRun(false);
    expect(await notifyMacos("hello", "CI", { run: f.run, has: () => false })).toBeNull();
  });

  test("prefers terminal-notifier when present (title/body as argv, no env)", async () => {
    const f = fakeRun(true);
    expect(await notifyMacos("hello", "CI", { run: f.run, has: () => true })).toBe("terminal-notifier");
    expect(f.calls[0]?.cmd).toEqual(["terminal-notifier", "-title", "CI", "-message", "hello"]);
    expect(f.calls[0]?.env).toBeUndefined();
  });

  test("a true failsafe: terminal-notifier installed but errors -> osascript fires", async () => {
    const f = fakeRun((cmd) => cmd[0] !== "terminal-notifier");
    expect(await notifyMacos("hello", "CI", { run: f.run, has: () => true })).toBe("osascript");
    expect(f.calls.map((c) => c.cmd[0])).toEqual(["terminal-notifier", "osascript"]);
  });

  test("terminal-notifier hostile text stays argv (never a script)", async () => {
    const f = fakeRun(true);
    const nasty = '"; rm -rf / #';
    await notifyMacos(nasty, 'ti"tle', { run: f.run, has: () => true });
    expect(f.calls[0]?.cmd).toEqual(["terminal-notifier", "-title", 'ti"tle', "-message", nasty]);
    expect(f.calls[0]?.env).toBeUndefined();
  });
});

describe("notifyLinux — notify-send, title/body as argv", () => {
  test("passes title and body as argv", async () => {
    const f = fakeRun(true);
    expect(await notifyLinux("body text", "Heads up", f.run)).toBe("notify-send");
    expect(f.calls[0]?.cmd).toEqual(["notify-send", "Heads up", "body text"]);
    expect(f.calls[0]?.env).toBeUndefined();
  });
  test("null on failure", async () => {
    const f = fakeRun(false);
    expect(await notifyLinux("body", "title", f.run)).toBeNull();
  });
  test("hostile text stays a single argv element", async () => {
    const f = fakeRun(true);
    const nasty = "$(rm -rf /); `whoami`";
    await notifyLinux(nasty, "title", f.run);
    expect(f.calls[0]?.cmd).toEqual(["notify-send", "title", nasty]);
  });
});

describe("the no-injection contract", () => {
  test("the AppleScript is static and reads both fields from the environment", () => {
    expect(MACOS_APPLESCRIPT).toContain("system attribute");
    expect(MACOS_APPLESCRIPT).toContain("PD_NOTIFY_MESSAGE");
    expect(MACOS_APPLESCRIPT).toContain("PD_NOTIFY_TITLE");
  });
  test("macOS hostile text never enters the script (only env)", async () => {
    const f = fakeRun(true);
    const nasty = '"; do shell script "rm -rf /"\n';
    await notifyMacos(nasty, 'ti"tle', { run: f.run, has: () => false });
    expect(f.calls[0]?.cmd).toEqual(["osascript", "-e", MACOS_APPLESCRIPT]);
    expect(f.calls[0]?.env).toEqual({ PD_NOTIFY_TITLE: 'ti"tle', PD_NOTIFY_MESSAGE: nasty });
  });
});

describe("notify() — mechanism-or-null glue (platform-independent)", () => {
  test("returns the worker's mechanism and threads message/title", async () => {
    const seen: Array<[string, string]> = [];
    const worker = async (message: string, title: string) => {
      seen.push([message, title]);
      return "osascript";
    };
    expect(await notify("hi", "T", worker)).toBe("osascript");
    expect(seen).toEqual([["hi", "T"]]);
  });
  test("returns null when no mechanism", async () => {
    expect(await notify("hi", "PreemDeck", async () => null)).toBeNull();
  });
  test("default title", async () => {
    const seen: Array<[string, string]> = [];
    await notify("hi", undefined, async (message, title) => {
      seen.push([message, title]);
      return null;
    });
    expect(seen).toEqual([["hi", "PreemDeck"]]);
  });
});

describe("platformWorker — sys.platform dispatch", () => {
  test("an exotic platform yields null (no desktop notifier)", async () => {
    expect(await platformWorker("sunos")("m", "t")).toBeNull();
  });
});
