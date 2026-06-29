/**
 * update.spec.ts — bun-test suite for update.ts.
 *
 * Same seam as install.spec: a per-call `fakeChild()` served through `spyOn(Bun, "spawn")`
 * stands in for real children — so no real `curl … | bash` ever runs. main() is driven
 * with an explicit `repoRoot` (a tmp fixture, with/without `.git`) and the spawn spy
 * branches on argv[0] (`git` describe vs the `bash` boot) so order doesn't matter.
 * `spyOn(process, "exit")` (mocked to throw, emulating non-return) drives the arg-parse
 * exit-code cases. Every spy is restored in afterEach.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOOT_URL, bootCommand, describeVersion, main, parseUpdateArgs } from "./update";

const context = describe;

// Canned Bun.Subprocess: drainable stdout/stderr + a resolved exit, so reap() and
// `await child.exited` both work without spawning a real child. Built per-call.
const fakeChild = (stdout = "", exitCode = 0, stderr = "") =>
  ({
    stdout: new Response(stdout).body,
    stderr: new Response(stderr).body,
    exited: Promise.resolve(exitCode),
    exitCode,
    kill() {},
  }) as unknown as Bun.Subprocess;

let spawnSpy: ReturnType<typeof spyOn<typeof Bun, "spawn">>;
const spawnCalls = (): string[][] => spawnSpy.mock.calls.map((c) => c[0] as string[]);
const bashCall = (): string[] | undefined => spawnCalls().find((c) => c[0] === "bash");

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "preemdeck-update-"));
  spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => fakeChild());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  spawnSpy.mockRestore();
});

/** A repoRoot that looks like a real checkout (has a .git dir). */
function gitRepo(): string {
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  return repo;
}

describe("update.ts", () => {
  context("parseUpdateArgs", () => {
    it("no args selects auto-detect (empty harnesses)", () => {
      expect(parseUpdateArgs([])).toEqual({ harnesses: [] });
    });

    it("accepts valid harness positionals", () => {
      expect(parseUpdateArgs(["claude", "gemini"])).toEqual({ harnesses: ["claude", "gemini"] });
    });

    it("rejects an invalid harness with exit 2", () => {
      const exit = spyOn(process, "exit").mockImplementation((() => {
        throw new Error("exit");
      }) as never);
      const err = spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        expect(() => parseUpdateArgs(["bogus"])).toThrow("exit");
        expect(exit).toHaveBeenCalledWith(2);
      } finally {
        exit.mockRestore();
        err.mockRestore();
      }
    });

    it("rejects any flag (no --dry-run: boot.sh's fetch + reset are not dry) with exit 2", () => {
      const exit = spyOn(process, "exit").mockImplementation((() => {
        throw new Error("exit");
      }) as never);
      const err = spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        expect(() => parseUpdateArgs(["--dry-run"])).toThrow("exit");
        expect(exit).toHaveBeenCalledWith(2);
      } finally {
        exit.mockRestore();
        err.mockRestore();
      }
    });
  });

  context("bootCommand", () => {
    it("streams curl|bash under pipefail, forwarding args after `bash -s --`", () => {
      const cmd = bootCommand("https://example/boot.sh", ["codex"]);
      expect(cmd[0]).toBe("bash");
      expect(cmd[1]).toBe("-c");
      expect(cmd[2]).toContain("set -o pipefail");
      expect(cmd[2]).toContain("curl -fsSL");
      expect(cmd[2]).toContain('bash -s -- "${@:2}"');
      // $0="bash", $1=url, $2…=forward
      expect(cmd.slice(3)).toEqual(["bash", "https://example/boot.sh", "codex"]);
    });

    it("forwards nothing when no harness is named", () => {
      expect(bootCommand(BOOT_URL, []).slice(3)).toEqual(["bash", BOOT_URL]);
    });
  });

  context("describeVersion", () => {
    it("returns the trimmed describe on success", async () => {
      spawnSpy.mockImplementation(() => fakeChild("v1.4.2\n", 0));
      expect(await describeVersion(dir)).toBe("v1.4.2");
    });

    it("returns '' on a non-zero git exit", async () => {
      spawnSpy.mockImplementation(() => fakeChild("", 128, "not a git repository"));
      expect(await describeVersion(dir)).toBe("");
    });

    it("returns '' when git is not on PATH (spawn throws)", async () => {
      spawnSpy.mockImplementation(() => {
        throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
      });
      expect(await describeVersion(dir)).toBe("");
    });
  });

  context("main", () => {
    it("aborts (exit 1) and runs no boot when ~/.preemdeck is not a git checkout", async () => {
      const err = spyOn(process.stderr, "write").mockImplementation(() => true);
      const log = spyOn(console, "log").mockImplementation(() => {});
      try {
        const rc = await main([], join(dir, "not-a-repo"));
        expect(rc).toBe(1);
        expect(bashCall()).toBeUndefined();
        expect((err.mock.calls[0]?.[0] as string) ?? "").toContain("not a git checkout");
      } finally {
        err.mockRestore();
        log.mockRestore();
      }
    });

    it("re-runs the canonical boot.sh and returns 0", async () => {
      spawnSpy.mockImplementation((cmd) => fakeChild((cmd as string[])[0] === "git" ? "v1.0.0\n" : "", 0));
      const log = spyOn(console, "log").mockImplementation(() => {});
      try {
        const rc = await main([], gitRepo());
        expect(rc).toBe(0);
        expect(bashCall()).toEqual(bootCommand(BOOT_URL, []));
      } finally {
        log.mockRestore();
      }
    });

    it("forwards a named harness to boot.sh", async () => {
      spawnSpy.mockImplementation((cmd) => fakeChild((cmd as string[])[0] === "git" ? "v1.0.0\n" : "", 0));
      const log = spyOn(console, "log").mockImplementation(() => {});
      try {
        await main(["codex"], gitRepo());
        expect(bashCall()).toEqual(bootCommand(BOOT_URL, ["codex"]));
      } finally {
        log.mockRestore();
      }
    });

    it("propagates boot.sh's non-zero exit", async () => {
      spawnSpy.mockImplementation((cmd) => fakeChild("", (cmd as string[])[0] === "git" ? 0 : 3));
      const log = spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(await main([], gitRepo())).toBe(3);
      } finally {
        log.mockRestore();
      }
    });

    it("reports the version delta old → new", async () => {
      let gitCalls = 0;
      spawnSpy.mockImplementation((cmd) => {
        if ((cmd as string[])[0] === "git") {
          gitCalls += 1;
          return fakeChild(gitCalls === 1 ? "v1.0.0\n" : "v1.1.0\n", 0);
        }
        return fakeChild("", 0);
      });
      const log = spyOn(console, "log").mockImplementation(() => {});
      try {
        await main([], gitRepo());
        const out = log.mock.calls.map((c) => String(c[0])).join("\n");
        expect(out).toContain("v1.0.0 → v1.1.0");
      } finally {
        log.mockRestore();
      }
    });
  });
});
