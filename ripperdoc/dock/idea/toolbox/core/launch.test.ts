/**
 * launch.test.ts — hermetic, no real subprocess or IDE. Port of test_launch.py.
 *
 * MOCK PATTERN A — dependency injection: launch() takes a `spawn` and a
 * `resolveExec` seam, so the test feeds a recording fake (captures argv, spies on
 * whether `.exited` was awaited) and a canned resolver. Asserts the exact spawned
 * argv, whether the native `--wait` is appended, whether the call blocks on the
 * child's exit, and that IdeaError propagates.
 */

import { describe, expect, test } from "bun:test";
import { IdeaError } from "./errors.ts";
import { launch, type Spawn } from "./launch.ts";

const FAKE_EXEC = "/Applications/WebStorm.app/Contents/MacOS/webstorm";

/** A recording fake child: captures argv, records whether `.exited` was awaited. */
class FakeChild {
  awaited = false;
  constructor(public argv: string[]) {}
  get exited(): Promise<number> {
    this.awaited = true;
    return Promise.resolve(0);
  }
}

const fakeSpawn = (): { spawn: Spawn; last: () => FakeChild | undefined } => {
  let child: FakeChild | undefined;
  const spawn: Spawn = (argv) => {
    child = new FakeChild(argv);
    return child as unknown as Bun.Subprocess;
  };
  return { spawn, last: () => child };
};

describe("launch", () => {
  test("default spawns the exact argv, async (no --wait, does not block)", async () => {
    const { spawn, last } = fakeSpawn();
    await launch(["diff", "/a", "/b"], { resolveExec: () => FAKE_EXEC, spawn });

    const child = last();
    expect(child).toBeDefined();
    expect(child?.argv).toEqual([FAKE_EXEC, "diff", "/a", "/b"]); // no --wait appended
    expect(child?.awaited).toBe(false); // async: did not block on .exited
  });

  test("wait:false does not append the flag or block", async () => {
    const { spawn, last } = fakeSpawn();
    await launch(["open", "/some/file"], { wait: false, resolveExec: () => FAKE_EXEC, spawn });

    expect(last()?.argv).not.toContain("--wait");
    expect(last()?.awaited).toBe(false);
  });

  test("wait:true appends --wait at the END and blocks on the child's exit", async () => {
    const { spawn, last } = fakeSpawn();
    await launch(["open", "/some/file"], { wait: true, resolveExec: () => FAKE_EXEC, spawn });

    const child = last();
    expect(child?.argv).toEqual([FAKE_EXEC, "open", "/some/file", "--wait"]);
    expect(child?.argv?.at(-1)).toBe("--wait");
    expect(child?.awaited).toBe(true); // blocked: awaited .exited
  });

  test("returns the (completed) child handle", async () => {
    const { spawn } = fakeSpawn();
    const child = await launch([], { wait: true, resolveExec: () => FAKE_EXEC, spawn });
    expect((child as unknown as FakeChild).awaited).toBe(true);
  });

  test("propagates IdeaError and never reaches spawn when resolve throws", async () => {
    let spawnCalled = false;
    const spawn: Spawn = () => {
      spawnCalled = true;
      throw new Error("spawn should not be called when resolve throws");
    };
    const resolveExec = (): string => {
      throw new IdeaError("no JetBrains IDE in the process ancestry");
    };

    await expect(launch(["diff", "/a", "/b"], { resolveExec, spawn })).rejects.toBeInstanceOf(IdeaError);
    expect(spawnCalled).toBe(false);
  });
});
