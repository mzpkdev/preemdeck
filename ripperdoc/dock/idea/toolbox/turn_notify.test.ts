/**
 * turn_notify.test.ts — hermetic port of test_turn_notify.py. The pure formatters
 * (cleanGist, title, payloadGist) are tested directly; gitBranch via an injected
 * spawn (the subprocess seam); readHookInput via Bun.stdin/isTTY spies; main end
 * to end via the notify / gitBranch / readHookInput seams. All DI — no
 * mock.module (which leaks across Bun's single-run suite).
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { _internals, cleanGist, GIST_MAX, main, payloadGist, title } from "./turn_notify.ts";

const real = {
  inIdea: _internals.inIdea,
  notify: _internals.notify,
  gitBranch: _internals.gitBranch,
  readHookInput: _internals.readHookInput,
  spawn: _internals.spawn,
};
afterEach(() => {
  _internals.inIdea = real.inIdea;
  _internals.notify = real.notify;
  _internals.gitBranch = real.gitBranch;
  _internals.readHookInput = real.readHookInput;
  _internals.spawn = real.spawn;
});

// --- pure formatters ---------------------------------------------------------

describe("cleanGist", () => {
  test("strips markdown, takes first answer line", () => {
    const text = '> ### Re: "old"\n\n**Yes** — the `pid` lives in the [backend](http://x) only.';
    expect(cleanGist(text)).toBe("Yes — the pid lives in the backend only.");
  });

  test("truncates on a word boundary with an ellipsis", () => {
    const gist = cleanGist("word ".repeat(60));
    expect([...gist].length).toBeLessThanOrEqual(GIST_MAX + 1);
    expect(gist.endsWith("…")).toBe(true);
    expect(gist).not.toContain("  ");
  });
});

describe("title", () => {
  test("project · branch", () => {
    expect(title("Claude", "/work/acme", "main")).toBe("acme · main");
  });
  test("trailing slash tolerated", () => {
    expect(title("Claude", "/work/acme/", null)).toBe("acme");
  });
  test("host fallback head", () => {
    expect(title("Claude", null, null)).toBe("Claude");
  });
});

describe("payloadGist", () => {
  test("reads each host field", () => {
    expect(payloadGist({ last_assistant_message: "**Done** — wired it." })).toBe("Done — wired it.");
    expect(payloadGist({ prompt_response: "Converted to async/await." })).toBe("Converted to async/await.");
  });
  test("null for missing, blank, and sentinel", () => {
    expect(payloadGist({})).toBeNull();
    expect(payloadGist({ last_assistant_message: null })).toBeNull();
    expect(payloadGist({ prompt_response: "   " })).toBeNull();
    expect(payloadGist({ prompt_response: "[no response text]" })).toBeNull();
  });
});

// --- branch fallback (git rev-parse via the spawn seam) ----------------------

describe("gitBranch", () => {
  test("returns the current branch", async () => {
    _internals.spawn = async () => ({ exitCode: 0, stdout: "feature/x\n", stderr: "", timedOut: false });
    expect(await _internals.gitBranch("/repo")).toBe("feature/x");
  });
  test("null for no cwd (no spawn at all)", async () => {
    let spawned = false;
    _internals.spawn = async () => {
      spawned = true;
      return { exitCode: 0, stdout: "x\n", stderr: "", timedOut: false };
    };
    expect(await _internals.gitBranch(null)).toBeNull();
    expect(spawned).toBe(false);
  });
  test("null for detached HEAD", async () => {
    _internals.spawn = async () => ({ exitCode: 0, stdout: "HEAD\n", stderr: "", timedOut: false });
    expect(await _internals.gitBranch("/repo")).toBeNull();
  });
  test("null for non-zero exit (not a repo)", async () => {
    _internals.spawn = async () => ({ exitCode: 128, stdout: "", stderr: "fatal", timedOut: false });
    expect(await _internals.gitBranch("/repo")).toBeNull();
  });
  test("null on spawn error", async () => {
    _internals.spawn = async () => {
      throw new Error("git not found");
    };
    expect(await _internals.gitBranch("/repo")).toBeNull();
  });
});

// --- stdin reader ------------------------------------------------------------

describe("readHookInput", () => {
  // Drive stdin via the isTTY flag + a Bun.stdin.text spy (no real pipe).
  const savedTTY = process.stdin.isTTY;
  const setTTY = (v: boolean) => {
    (process.stdin as { isTTY?: boolean }).isTTY = v;
  };
  afterEach(() => {
    (process.stdin as { isTTY?: boolean }).isTTY = savedTTY;
  });

  test("parses JSON", async () => {
    setTTY(false);
    const stdinSpy = spyOn(Bun.stdin, "text").mockResolvedValue('{"cwd": "/x", "last_assistant_message": "hi"}');
    try {
      expect(await _internals.readHookInput()).toEqual({ cwd: "/x", last_assistant_message: "hi" });
    } finally {
      stdinSpy.mockRestore();
    }
  });

  test("garbage and empty yield {}", async () => {
    setTTY(false);
    let stdinSpy = spyOn(Bun.stdin, "text").mockResolvedValue("not json");
    try {
      expect(await _internals.readHookInput()).toEqual({});
      stdinSpy.mockRestore();
      stdinSpy = spyOn(Bun.stdin, "text").mockResolvedValue("");
      expect(await _internals.readHookInput()).toEqual({});
    } finally {
      stdinSpy.mockRestore();
    }
  });

  test("tty yields {} without reading", async () => {
    setTTY(true);
    expect(await _internals.readHookInput()).toEqual({});
  });
});

// --- main() end to end -------------------------------------------------------

function capture(): Array<{ body: string; title: string }> {
  const calls: Array<{ body: string; title: string }> = [];
  _internals.inIdea = () => true;
  _internals.notify = async (message: string, options: { title?: string } = {}) => {
    calls.push({ body: message, title: options.title ?? "PreemDeck" });
  };
  return calls;
}

describe("main", () => {
  test("Claude gist from last_assistant_message + git branch", async () => {
    const calls = capture();
    _internals.gitBranch = async () => "main";
    _internals.readHookInput = async () => ({ cwd: "/work/acme", last_assistant_message: "Probed the hook." });
    expect(await main(["Claude"])).toBe(0);
    expect(calls).toEqual([{ title: "acme · main", body: "Probed the hook." }]);
  });

  test("Gemini gist from prompt_response", async () => {
    const calls = capture();
    _internals.gitBranch = async () => "main";
    _internals.readHookInput = async () => ({
      cwd: "/work/acme",
      prompt_response: "Converted the middleware to async/await.",
    });
    expect(await main(["Gemini"])).toBe(0);
    expect(calls).toEqual([{ title: "acme · main", body: "Converted the middleware to async/await." }]);
  });

  test("tool-only turn falls back to host-label body", async () => {
    const calls = capture();
    _internals.gitBranch = async () => "feat/codex";
    _internals.readHookInput = async () => ({ cwd: "/work/acme", last_assistant_message: null });
    expect(await main(["Codex"])).toBe(0);
    expect(calls).toEqual([{ title: "acme · feat/codex", body: "Codex finished responding" }]);
  });

  test("HTML-escapes dynamic text", async () => {
    const calls = capture();
    _internals.gitBranch = async () => null;
    _internals.readHookInput = async () => ({ cwd: "/x/proj", last_assistant_message: "use <T> & <U>" });
    await main(["Claude"]);
    expect(calls[0]?.body).toBe("use &lt;T&gt; &amp; &lt;U&gt;");
  });

  test("no payload, no cwd -> host-label title head + fallback body", async () => {
    const calls = capture();
    _internals.gitBranch = async () => null;
    _internals.readHookInput = async () => ({});
    const savedPwd = process.env["PWD"];
    delete process.env["PWD"];
    try {
      expect(await main(["Gemini"])).toBe(0);
      expect(calls).toEqual([{ title: "Gemini", body: "Gemini finished responding" }]);
    } finally {
      if (savedPwd === undefined) delete process.env["PWD"];
      else process.env["PWD"] = savedPwd;
    }
  });

  test("gate: no IDE -> no balloon, exit 0", async () => {
    const calls: unknown[] = [];
    _internals.inIdea = () => false;
    _internals.notify = async () => {
      calls.push({});
    };
    expect(await main(["Claude"])).toBe(0);
    expect(calls).toEqual([]);
  });
});
