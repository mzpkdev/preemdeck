/**
 * inject-hook.test.ts — Tmp-fixture FS for templates / host-tools files; DI
 * stdin/write for the envelope. Absolute temp paths are honored verbatim
 * (resolve()'s "absolute wins"), which the suite relies on.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInjectionHook } from "../../../../lib/inject.ts";
import { extractEventArg, renderTemplate, resolveTemplateArg } from "./inject-hook.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "preemdeck-injhook-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

let counter = 0;
const writeTmp = async (content: string): Promise<string> => {
  const p = join(dir, `f${counter++}.md`);
  await writeFile(p, content);
  return p;
};

// Mirror main(): split --event, then render, then emit with the injected stdin.
const runHookCli = async (argv: string[], stdinText: string): Promise<{ out: string }> => {
  const [cliEvent, rest] = extractEventArg(argv);
  // pluginRoot is irrelevant here: tests pass absolute paths, which resolve() honors verbatim.
  const text = await renderTemplate(rest);
  let out = "";
  await runInjectionHook({
    event: cliEvent ?? undefined,
    stdin: { text: () => Promise.resolve(stdinText) },
    write: (l) => {
      out = l;
    },
    render: () => text,
  });
  return { out };
};

describe("extractEventArg", () => {
  test("pulls the first --event and leaves the rest", () => {
    expect(extractEventArg(["IMPRINT.md", "--event", "BeforeAgent", "hosts/h.md"])).toEqual([
      "BeforeAgent",
      ["IMPRINT.md", "hosts/h.md"],
    ]);
  });
  test("only the first --event is honored", () => {
    expect(extractEventArg(["--event", "A", "--event", "B"])).toEqual(["A", ["--event", "B"]]);
  });
  test("a dangling --event yields null", () => {
    expect(extractEventArg(["--event"])).toEqual([null, []]);
  });
});

describe("resolveTemplateArg", () => {
  test("--file <name> -> <NAME>.md", () => {
    expect(resolveTemplateArg(["--file", "imprint", "x"])).toEqual(["IMPRINT.md", ["x"]]);
  });
  test("a bare path is used verbatim", () => {
    expect(resolveTemplateArg(["IMPRINT.md", "hosts/h.md"])).toEqual(["IMPRINT.md", ["hosts/h.md"]]);
  });
  test("no args -> null", () => {
    expect(resolveTemplateArg([])).toEqual([null, []]);
  });
  test("--file with no name -> null", () => {
    expect(resolveTemplateArg(["--file"])).toEqual([null, []]);
  });
});

describe("inject-hook CLI", () => {
  test("substitutes {{host_tools}}", async () => {
    const template = await writeTmp("# T\n\n{{host_tools}}\n");
    const host = await writeTmp("HOST_TOOLS_MARKER");
    const { out } = await runHookCli([template, host], "{}");
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("HOST_TOOLS_MARKER");
    expect(ctx).not.toContain("{{host_tools}}");
  });

  test("--event supplies the fallback event", async () => {
    const template = await writeTmp("body\n");
    const { out } = await runHookCli([template, "--event", "BeforeAgent"], "{}");
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("BeforeAgent");
  });

  test("stdin event wins over the flag", async () => {
    const template = await writeTmp("body\n");
    const { out } = await runHookCli([template, "--event", "BeforeAgent"], '{"hook_event_name":"UserPromptSubmit"}');
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  });

  test("default event when unspecified", async () => {
    const template = await writeTmp("body\n");
    const { out } = await runHookCli([template], "{}");
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  });

  test("missing template -> {} no-op", async () => {
    const { out } = await runHookCli(["/nonexistent/template/____.md"], "{}");
    expect(out).toBe("{}");
  });

  test("missing host-tools file -> placeholder collapses to empty, still emits", async () => {
    const template = await writeTmp("before {{host_tools}} after\n");
    const { out } = await runHookCli([template, "/nonexistent/host/____.md"], "{}");
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    expect(ctx).not.toContain("{{host_tools}}");
    expect(ctx).toContain("before");
    expect(ctx).toContain("after");
  });

  test("whitespace-only template -> {} no-op", async () => {
    const template = await writeTmp("   \n\t\n");
    const { out } = await runHookCli([template], "{}");
    expect(out).toBe("{}");
  });

  test("template without the placeholder -> emitted unchanged", async () => {
    const template = await writeTmp("just some static body\n");
    const { out } = await runHookCli([template], "{}");
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toBe("just some static body");
  });

  test("--file imprint --event SessionStart parses with --event present", async () => {
    // Resolves IMPRINT.md against the real plugin root (renderTemplate default).
    const [cliEvent, rest] = extractEventArg(["--file", "imprint", "--event", "SessionStart"]);
    const text = await renderTemplate(rest);
    let out = "";
    await runInjectionHook({
      event: cliEvent ?? undefined,
      stdin: { text: () => Promise.resolve("{}") },
      write: (l) => {
        out = l;
      },
      render: () => text,
    });
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("SessionStart");
  });
});
