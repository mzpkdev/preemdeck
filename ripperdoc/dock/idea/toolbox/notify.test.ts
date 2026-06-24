/**
 * notify.test.ts — hermetic tests. Two layers:
 *   - the CLI (main): the `notify` worker is injected as a recorder via
 *     `_internals.notify`; nothing spawns. Defaults, --type/--action validation,
 *     the inIdea gate, and exit codes are asserted.
 *   - the Groovy render (notify worker end to end): `_internals.runGroovy` is a
 *     recorder capturing the generated Groovy (the engine seam — NOT mock.module,
 *     which leaks). The escaped title/message land as literals, each --type maps
 *     to the right constant, and the action closures match previewUrl's fragment.
 * All via DI seams kept hermetic across Bun's single-run suite.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { IdeaError, NotImplementedError } from "./core/errors.ts";
import { escapeGroovy, webpreviewOpenBody } from "./core/index.ts";
import { _internals, main, type NotifyOptions, notify } from "./notify.ts";

const real = { inIdea: _internals.inIdea, runGroovy: _internals.runGroovy, notify: _internals.notify };

beforeEach(() => {
  _internals.inIdea = () => true;
});
afterEach(() => {
  _internals.inIdea = real.inIdea;
  _internals.runGroovy = real.runGroovy;
  _internals.notify = real.notify;
});

// --- CLI seam: a recorder standing in for the notify worker ------------------

const captureNotify = (): Array<{ message: string; title: string; type: string; actions: unknown }> => {
  const captured: Array<{ message: string; title: string; type: string; actions: unknown }> = [];
  _internals.notify = async (message: string, options: NotifyOptions = {}) => {
    captured.push({
      message,
      title: options.title ?? "PreemDeck",
      type: options.typeToken ?? "info",
      actions: options.actions ?? [],
    });
  };
  return captured;
};

describe("main (CLI)", () => {
  test("message only -> defaults, exit 0", async () => {
    const captured = captureNotify();
    expect(await main(["build finished"])).toBe(0);
    expect(captured).toEqual([{ message: "build finished", title: "PreemDeck", type: "info", actions: [] }]);
  });

  test("threads title and type", async () => {
    const captured = captureNotify();
    expect(await main(["tests failed", "--title", "CI", "--type", "error"])).toBe(0);
    expect(captured[0]).toMatchObject({ message: "tests failed", title: "CI", type: "error" });
  });

  test.each(["info", "warning", "error"])("accepts --type %s", async (kind) => {
    const captured = captureNotify();
    expect(await main(["msg", "--type", kind])).toBe(0);
    expect(captured[0]?.type).toBe(kind);
  });

  test("unknown --type -> exit 2, worker untouched", async () => {
    const captured = captureNotify();
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      await expect(main(["msg", "--type", "fatal"])).rejects.toThrow("exit:2");
      expect(captured).toEqual([]);
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain("usage:");
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test("missing message -> exit 2", async () => {
    captureNotify();
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      await expect(main([])).rejects.toThrow("exit:2");
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test("threads a single action", async () => {
    const captured = captureNotify();
    expect(await main(["msg", "--action", "open-url=https://example.com"])).toBe(0);
    expect(captured[0]?.actions).toEqual([{ name: "open-url", arg: "https://example.com" }]);
  });

  test("multiple actions preserve CLI order", async () => {
    const captured = captureNotify();
    await main(["msg", "--action", "open-preview=https://x", "--action", "open-file=/tmp"]);
    expect(captured[0]?.actions).toEqual([
      { name: "open-preview", arg: "https://x" },
      { name: "open-file", arg: "/tmp" },
    ]);
  });

  test("action arg splits on the FIRST = only", async () => {
    const captured = captureNotify();
    await main(["msg", "--action", "open-url=https://example.com/search?a=1&b=2"]);
    expect(captured[0]?.actions).toEqual([{ name: "open-url", arg: "https://example.com/search?a=1&b=2" }]);
  });

  test("unknown action -> exit 2, worker untouched", async () => {
    const captured = captureNotify();
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      await expect(main(["msg", "--action", "open-everything=x"])).rejects.toThrow("exit:2");
      expect(captured).toEqual([]);
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test("action missing required arg -> exit 2", async () => {
    const captured = captureNotify();
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      await expect(main(["msg", "--action", "open-url"])).rejects.toThrow("exit:2");
      expect(captured).toEqual([]);
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test("outside JetBrains -> 1 before work, even with actions", async () => {
    _internals.inIdea = () => false;
    const captured = captureNotify();
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      expect(await main(["msg", "--action", "open-url=https://example.com"])).toBe(1);
      expect(captured).toEqual([]);
      expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("")).toContain(
        "notify: no JetBrains IDE in the process ancestry",
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  test("worker IdeaError -> 1", async () => {
    _internals.notify = async () => {
      throw new IdeaError("no JetBrains IDE in the process ancestry");
    };
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      expect(await main(["build finished"])).toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("worker NotImplementedError -> 1", async () => {
    _internals.notify = async () => {
      throw new NotImplementedError("not implemented for Linux yet");
    };
    const errSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      expect(await main(["build finished"])).toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});

// --- the rendered Groovy (notify worker end to end, runGroovy seam) ----------

const captureGroovy = (): { scripts: string[]; notes: string[] } => {
  const captured = { scripts: [] as string[], notes: [] as string[] };
  _internals.runGroovy = async (groovy: string, note: string) => {
    captured.scripts.push(groovy);
    captured.notes.push(note);
  };
  return captured;
};

describe("notify worker (Groovy render)", () => {
  test("injects message, title, group, and Bus.notify", async () => {
    const cap = captureGroovy();
    await notify("build finished", { title: "CI" });
    const g = cap.scripts[0] as string;
    expect(g).toContain("new Notification(");
    expect(g).toContain("Notifications.Bus.notify(n, project)");
    expect(g).toContain("getOpenProjects()");
    expect(g).toContain('"CI"');
    expect(g).toContain('"build finished"');
    expect(g).toContain('"idea.toolbox"');
  });

  test("default title is PreemDeck", async () => {
    const cap = captureGroovy();
    await notify("hello");
    expect(cap.scripts[0]).toContain('"PreemDeck"');
  });

  test.each([
    ["info", "INFORMATION"],
    ["warning", "WARNING"],
    ["error", "ERROR"],
  ])("--type %s maps to NotificationType.%s", async (kind, constant) => {
    const cap = captureGroovy();
    await notify("msg", { typeToken: kind });
    expect(cap.scripts[0]).toContain(`NotificationType.${constant}`);
  });

  test("escapes quotes and backslashes in message + title", async () => {
    const cap = captureGroovy();
    await notify('he said "hi"\\done', { title: 'ti"tle\\x' });
    const g = cap.scripts[0] as string;
    expect(g).toContain('he said \\"hi\\"\\\\done');
    expect(g).toContain('ti\\"tle\\\\x');
    expect(g).not.toContain('"he said "hi"\\done"');
  });

  test("no actions -> no addAction, Bus.notify follows directly", async () => {
    const cap = captureGroovy();
    await notify("hello");
    const g = cap.scripts[0] as string;
    expect(g).not.toContain("addAction");
    expect(g).toContain("NotificationType.INFORMATION)\n    Notifications.Bus.notify(n, project)");
  });

  test("open-url renders the browse closure", async () => {
    const cap = captureGroovy();
    await notify("msg", { actions: [{ name: "open-url", arg: "https://example.com" }] });
    const g = cap.scripts[0] as string;
    expect(g).toContain('NotificationAction.createSimple("Open in browser"');
    expect(g).toContain('com.intellij.ide.BrowserUtil.browse("https://example.com")');
    expect(g).toContain("as Runnable))");
  });

  test("open-file renders the editor-open closure (re-fetched project, no shadow)", async () => {
    const cap = captureGroovy();
    await notify("msg", { actions: [{ name: "open-file", arg: "/tmp/build.log" }] });
    const g = cap.scripts[0] as string;
    expect(g).toContain('NotificationAction.createSimple("Open file"');
    expect(g).toContain('LocalFileSystem.getInstance().findFileByPath("/tmp/build.log")');
    expect(g).toContain("if (vf == null) return");
    expect(g).toContain("FileEditorManager.getInstance(actionProject).openFile(vf, true)");
  });

  test("open-preview reuses the shared webpreview fragment verbatim (parity with previewUrl)", async () => {
    const cap = captureGroovy();
    const url = "http://localhost:3000";
    await notify("msg", { actions: [{ name: "open-preview", arg: url }] });
    const g = cap.scripts[0] as string;
    expect(g).toContain('NotificationAction.createSimple("Open preview"');
    const fragment = webpreviewOpenBody(escapeGroovy(url), escapeGroovy(url), {
      projectVar: "actionProject",
      indent: " ".repeat(8),
    });
    expect(g).toContain(fragment);
  });

  test("multiple actions render in CLI order", async () => {
    const cap = captureGroovy();
    await notify("msg", {
      actions: [
        { name: "open-preview", arg: "https://x" },
        { name: "open-file", arg: "/tmp" },
      ],
    });
    const g = cap.scripts[0] as string;
    expect((g.match(/addAction/g) ?? []).length).toBe(2);
    expect(g.indexOf('createSimple("Open preview"')).toBeLessThan(g.indexOf('createSimple("Open file"'));
  });

  test("action arg is escaped", async () => {
    const cap = captureGroovy();
    await notify("msg", { actions: [{ name: "open-url", arg: 'https://x/?q="a\\b"' }] });
    const g = cap.scripts[0] as string;
    expect(g).toContain('browse("https://x/?q=\\"a\\\\b\\"")');
    expect(g).not.toContain('browse("https://x/?q="a\\b"")');
  });

  test.each(["open-file", "open-preview"])("%s re-fetch does not shadow the enclosing scope", async (action) => {
    const cap = captureGroovy();
    await notify("msg", { actions: [{ name: action, arg: "x" }] });
    const g = cap.scripts[0] as string;
    expect(g).not.toContain("        def project ");
    expect(g).not.toContain("        def projects ");
    expect(g).toContain("        def actionProject ");
  });

  test("runs exactly one blocking ideScript with the right note", async () => {
    const cap = captureGroovy();
    await notify("hello");
    expect(cap.scripts.length).toBe(1);
    expect(cap.notes[0]).toBe("notify: could not pop notification");
  });
});
