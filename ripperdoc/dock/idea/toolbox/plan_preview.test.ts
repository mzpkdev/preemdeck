/**
 * plan_preview.test.ts — hermetic port of test_plan_preview.py. The openers
 * (openFile/openInline), inIdea, and readHookInput are injected via `_internals`.
 * main() routes the plan by field, is gated on a live IDE, swallows opener
 * failures, and always returns 0.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { _internals, main, readHookInput } from "./plan_preview.ts";

const real = {
  inIdea: _internals.inIdea,
  openFile: _internals.openFile,
  openInline: _internals.openInline,
  readHookInput: _internals.readHookInput,
};
let calls: { inline: Array<[string, unknown]>; file: Array<[string, unknown]> };

function capture(): void {
  calls = { inline: [], file: [] };
  _internals.inIdea = () => true;
  _internals.openInline = async (content: string, options?: unknown) => {
    calls.inline.push([content, options]);
    return null;
  };
  _internals.openFile = async (path: string, options?: unknown) => {
    calls.file.push([path, options]);
    return null;
  };
}

beforeEach(() => {
  capture();
});
afterEach(() => {
  _internals.inIdea = real.inIdea;
  _internals.openFile = real.openFile;
  _internals.openInline = real.openInline;
  _internals.readHookInput = real.readHookInput;
});

describe("readHookInput", () => {
  const savedTTY = process.stdin.isTTY;
  afterEach(() => {
    (process.stdin as { isTTY?: boolean }).isTTY = savedTTY;
  });

  test("parses JSON", async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = false;
    const stdinSpy = spyOn(Bun.stdin, "text").mockResolvedValue('{"tool_input": {"plan": "hi"}}');
    try {
      expect(await readHookInput()).toEqual({ tool_input: { plan: "hi" } });
    } finally {
      stdinSpy.mockRestore();
    }
  });

  test("garbage and empty yield {}", async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = false;
    let stdinSpy = spyOn(Bun.stdin, "text").mockResolvedValue("not json");
    try {
      expect(await readHookInput()).toEqual({});
      stdinSpy.mockRestore();
      stdinSpy = spyOn(Bun.stdin, "text").mockResolvedValue("");
      expect(await readHookInput()).toEqual({});
    } finally {
      stdinSpy.mockRestore();
    }
  });
});

describe("main", () => {
  test("Claude inline plan string -> openInline as markdown + preview", async () => {
    _internals.readHookInput = async () => ({ tool_input: { plan: "# Plan\n\n- step" } });
    expect(await main()).toBe(0);
    expect(calls.inline).toEqual([["# Plan\n\n- step", { suffix: ".md", preview: true }]]);
    expect(calls.file).toEqual([]);
  });

  test("Gemini plan_path -> openFile with preview", async () => {
    const path = "/home/u/.gemini/tmp/proj/plans/plan.md";
    _internals.readHookInput = async () => ({ tool_input: { plan_path: path } });
    expect(await main()).toBe(0);
    expect(calls.file).toEqual([[path, { preview: true }]]);
    expect(calls.inline).toEqual([]);
  });

  test("plan_path takes precedence over plan", async () => {
    _internals.readHookInput = async () => ({ tool_input: { plan: "inline", plan_path: "/p/plan.md" } });
    expect(await main()).toBe(0);
    expect(calls.file).toEqual([["/p/plan.md", { preview: true }]]);
    expect(calls.inline).toEqual([]);
  });

  test.each([
    {},
    { tool_input: {} },
    { tool_input: { plan: "   " } },
    { tool_input: { plan_path: "" } },
    { tool_input: { plan: ["not", "a", "str"] } },
    { tool_input: "not-a-dict" },
  ])("no-op for %p", async (payload) => {
    _internals.readHookInput = async () => payload as Record<string, unknown>;
    expect(await main()).toBe(0);
    expect(calls.inline).toEqual([]);
    expect(calls.file).toEqual([]);
  });

  test("gate: no IDE -> no open", async () => {
    _internals.inIdea = () => false;
    _internals.readHookInput = async () => ({ tool_input: { plan: "# Plan" } });
    expect(await main()).toBe(0);
    expect(calls.inline).toEqual([]);
    expect(calls.file).toEqual([]);
  });

  test("swallows opener failure and exits 0", async () => {
    _internals.readHookInput = async () => ({ tool_input: { plan: "# Plan" } });
    _internals.openInline = async () => {
      throw new Error("IDE went away");
    };
    expect(await main()).toBe(0);
  });
});
