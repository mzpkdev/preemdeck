/**
 * lib/hook.test.ts — also the canonical injected-DI mock pattern.
 *
 * MOCK PATTERN A — dependency injection. `runHook` takes `stdin`/`write` so a
 * test feeds a fake stdin and captures the emitted line without touching the
 * real fds. Prefer this (no global patching) when the unit already accepts its
 * collaborators. See proc.test.ts for real-subprocess and jsonStore.test.ts for
 * tmp-fixture patterns; the spyOn-on-globals pattern is shown in MOCK PATTERN B.
 */

import { describe, expect, mock, spyOn, test } from "bun:test";
import { runHook } from "./hook.ts";

function fakeStdin(text: string) {
  return { text: () => Promise.resolve(text) };
}

describe("runHook", () => {
  test("emits the exact injection envelope when render returns text", async () => {
    let out = "";
    await runHook({
      stdin: fakeStdin('{"hook_event_name":"UserPromptSubmit"}'),
      write: (line) => {
        out = line;
      },
      render: () => "INJECTED",
    });
    // Byte-for-byte the Python json.dumps shape (compact separators).
    expect(out).toBe('{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"INJECTED"}}');
  });

  test("stdin hook_event_name wins over the event option", async () => {
    let out = "";
    await runHook({
      event: "SessionStart",
      stdin: fakeStdin('{"hook_event_name":"BeforeAgent"}'),
      write: (line) => {
        out = line;
      },
      render: () => "x",
    });
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("BeforeAgent");
  });

  test("falls back to the event option, then to UserPromptSubmit", async () => {
    let out = "";
    await runHook({
      event: "SessionStart",
      stdin: fakeStdin("{}"),
      write: (l) => {
        out = l;
      },
      render: () => "x",
    });
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("SessionStart");

    out = "";
    await runHook({
      stdin: fakeStdin("{}"),
      write: (l) => {
        out = l;
      },
      render: () => "x",
    });
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  });

  test("empty or invalid stdin degrades to {} payload, render still runs", async () => {
    const seen: unknown[] = [];
    let out = "";
    await runHook({
      stdin: fakeStdin(""),
      write: (l) => {
        out = l;
      },
      render: (p) => {
        seen.push(p);
        return "ok";
      },
    });
    expect(seen[0]).toEqual({});
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toBe("ok");

    await runHook({
      stdin: fakeStdin("}{ not json"),
      write: (l) => {
        out = l;
      },
      render: (p) => {
        seen.push(p);
        return "ok";
      },
    });
    expect(seen[1]).toEqual({});
  });

  test("render -> null (or empty string) emits exactly {} (no-op)", async () => {
    let out = "";
    await runHook({ stdin: fakeStdin("{}"), write: (l) => (out = l), render: () => null });
    expect(out).toBe("{}");
    await runHook({ stdin: fakeStdin("{}"), write: (l) => (out = l), render: () => "" });
    expect(out).toBe("{}");
  });

  test("a throwing render is a no-op, never propagates", async () => {
    let out = "";
    await runHook({
      stdin: fakeStdin("{}"),
      write: (l) => (out = l),
      render: () => {
        throw new Error("boom");
      },
    });
    expect(out).toBe("{}");
  });

  test("an array payload is treated as {} (matches Python isinstance(dict) guard)", async () => {
    const seen: unknown[] = [];
    await runHook({
      stdin: fakeStdin("[1,2,3]"),
      write: () => {},
      render: (p) => {
        seen.push(p);
        return null;
      },
    });
    expect(seen[0]).toEqual({});
  });

  test("MOCK PATTERN B — spyOn a global (console.log) instead of injecting", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      // No `write` override -> runHook uses console.log; the spy captures it.
      await runHook({ stdin: fakeStdin("{}"), render: () => "viaSpy" });
      expect(spy).toHaveBeenCalledTimes(1);
      const firstCall = spy.mock.calls[0] as [string];
      expect(JSON.parse(firstCall[0]).hookSpecificOutput.additionalContext).toBe("viaSpy");
    } finally {
      spy.mockRestore(); // ALWAYS restore in finally so other tests see the real fn.
    }
  });
});

// MOCK PATTERN C — module mock. Replace a whole import for the file under test.
// Shown here as the reference call; porting fixers use it to stub `./proc.ts`,
// `./jsonStore.ts`, etc. Must run BEFORE the consumer imports the module.
mock.module("./__example_dep.ts", () => ({ value: 42 }));
