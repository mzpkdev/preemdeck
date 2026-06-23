/**
 * inject.test.ts — the byte-exact injection runner. Same contract as hook.test.ts
 * (DI stdin/write), but the emitted line must match Python's bare json.dumps
 * (spaced separators + ensure_ascii), which is the whole reason this exists.
 */

import { describe, expect, test } from "bun:test";
import { runInjectionHook } from "./inject.ts";

const fakeStdin = (text: string) => ({ text: () => Promise.resolve(text) });

describe("runInjectionHook", () => {
  test("emits the Python-faithful envelope (spaced separators, ascii-escaped)", async () => {
    let out = "";
    await runInjectionHook({
      stdin: fakeStdin('{"hook_event_name":"UserPromptSubmit"}'),
      write: (l) => {
        out = l;
      },
      render: () => "café — ok",
    });
    expect(out).toBe(
      '{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "caf\\u00e9 \\u2014 ok"}}',
    );
  });

  test("stdin hook_event_name wins over the event option", async () => {
    let out = "";
    await runInjectionHook({
      event: "SessionStart",
      stdin: fakeStdin('{"hook_event_name":"BeforeAgent"}'),
      write: (l) => {
        out = l;
      },
      render: () => "x",
    });
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("BeforeAgent");
  });

  test("falls back to the event option, then to UserPromptSubmit", async () => {
    let out = "";
    await runInjectionHook({
      event: "SessionStart",
      stdin: fakeStdin("{}"),
      write: (l) => (out = l),
      render: () => "x",
    });
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("SessionStart");
    await runInjectionHook({ stdin: fakeStdin("{}"), write: (l) => (out = l), render: () => "x" });
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  });

  test("empty/invalid/array stdin -> {} payload, render still runs", async () => {
    const seen: unknown[] = [];
    const capture = (p: Record<string, unknown>): null => {
      seen.push(p);
      return null;
    };
    await runInjectionHook({ stdin: fakeStdin(""), write: () => {}, render: capture });
    await runInjectionHook({ stdin: fakeStdin("}{"), write: () => {}, render: capture });
    await runInjectionHook({ stdin: fakeStdin("[1,2]"), write: () => {}, render: capture });
    expect(seen).toEqual([{}, {}, {}]);
  });

  test("render -> null or empty emits exactly {}", async () => {
    let out = "";
    await runInjectionHook({ stdin: fakeStdin("{}"), write: (l) => (out = l), render: () => null });
    expect(out).toBe("{}");
    await runInjectionHook({ stdin: fakeStdin("{}"), write: (l) => (out = l), render: () => "" });
    expect(out).toBe("{}");
  });

  test("a throwing render is a no-op", async () => {
    let out = "";
    await runInjectionHook({
      stdin: fakeStdin("{}"),
      write: (l) => (out = l),
      render: () => {
        throw new Error("boom");
      },
    });
    expect(out).toBe("{}");
  });
});
