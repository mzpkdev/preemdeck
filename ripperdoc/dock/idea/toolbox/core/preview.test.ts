/**
 * preview.test.ts — hermetic: no real IDE, no ideScript, no polling. Port of
 * test_preview.py, PLUS a byte-for-byte golden diff against the Python engine's
 * output for representative inputs.
 *
 * setPreview/previewUrl drive a rendered preview through an ideScript run. The
 * IDE-facing seams are injected via runGroovy's `deps`: `launch` is a recording
 * spy (spawns nothing, reads the generated temp groovy back) and `reapLater` is a
 * spy that records + unlinks. We assert the spawned argv, the Groovy injected
 * into the temp (byte-identical to Python's, captured as GOLDEN_* below), the
 * deferred reap, and the never-throw graceful-degrade contract.
 *
 * The GOLDEN_* constants are the EXACT bytes the Python `_preview`/`_groovy`
 * emit (verified byte-identical via a standalone diff). They lock the
 * string-gen parity into the committed suite, no Python at test time.
 */

import { describe, expect, test } from "bun:test";
import { IdeaError, NotImplementedError } from "./errors.ts";
import type { RunGroovyDeps } from "./groovy.ts";
import { previewUrl, setPreview, webpreviewOpenBody } from "./preview.ts";

// --- GOLDEN OUTPUTS (byte-identical to the Python engine) --------------------

const GOLDEN_SETLAYOUT_MD = `import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.TextEditorWithPreview
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ide.DataManager

ApplicationManager.getApplication().invokeLater {
    def vFile = LocalFileSystem.getInstance().findFileByPath("/Users/me/notes.md")
    if (vFile == null) return
    def projects = ProjectManager.getInstance().getOpenProjects()
    if (projects.length == 0) return
    def project = projects[0]
    def manager = FileEditorManager.getInstance(project)
    manager.openFile(vFile, true)
    def editor = manager.getSelectedEditor(vFile)
    if (editor instanceof TextEditorWithPreview) {
        editor.setLayout(TextEditorWithPreview.Layout.SHOW_PREVIEW)
    }
}
`;

const GOLDEN_WEBPREVIEW_HTML = `import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.util.registry.Registry
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.util.Urls
import com.intellij.ide.browsers.actions.WebPreviewVirtualFile

ApplicationManager.getApplication().invokeLater {
    try {
        def projects = ProjectManager.getInstance().getOpenProjects()
        if (projects.length == 0) return
        def project = projects[0]
        def vFile = LocalFileSystem.getInstance().refreshAndFindFileByPath("/Users/me/page.html")
        if (vFile == null) return
        if (!(Registry.is("ide.web.preview.enabled") && Registry.is("ide.browser.jcef.enabled"))) return
        def url = Urls.newFromVirtualFile(vFile)
        def previewFile = new WebPreviewVirtualFile(vFile, url)
        FileEditorManager.getInstance(project).openFile(previewFile, true)
    } catch (Throwable t) {
        t.printStackTrace()
    }
}
`;

const GOLDEN_SETLAYOUT_ESCAPED = `import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.TextEditorWithPreview
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ide.DataManager

ApplicationManager.getApplication().invokeLater {
    def vFile = LocalFileSystem.getInstance().findFileByPath("/tmp/we\\"ird\\\\name.md")
    if (vFile == null) return
    def projects = ProjectManager.getInstance().getOpenProjects()
    if (projects.length == 0) return
    def project = projects[0]
    def manager = FileEditorManager.getInstance(project)
    manager.openFile(vFile, true)
    def editor = manager.getSelectedEditor(vFile)
    if (editor instanceof TextEditorWithPreview) {
        editor.setLayout(TextEditorWithPreview.Layout.SHOW_PREVIEW)
    }
}
`;

const GOLDEN_URL_HOSTPORT = `import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.ProjectManager

ApplicationManager.getApplication().invokeLater {
    try {
        def projects = ProjectManager.getInstance().getOpenProjects()
        if (projects.length == 0) return
        def project = projects[0]
        if (!(com.intellij.openapi.util.registry.Registry.is("ide.web.preview.enabled") && com.intellij.openapi.util.registry.Registry.is("ide.browser.jcef.enabled"))) return
        def url = com.intellij.util.Urls.newFromEncoded("http://localhost:3000")
        def dummy = new com.intellij.testFramework.LightVirtualFile("localhost:3000")
        def previewFile = new com.intellij.ide.browsers.actions.WebPreviewVirtualFile(dummy, url)
        com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFile(previewFile, true)
    } catch (Throwable t) {
        t.printStackTrace()
    }
}
`;

const GOLDEN_URL_QUERY_SPECIALS = `import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.ProjectManager

ApplicationManager.getApplication().invokeLater {
    try {
        def projects = ProjectManager.getInstance().getOpenProjects()
        if (projects.length == 0) return
        def project = projects[0]
        if (!(com.intellij.openapi.util.registry.Registry.is("ide.web.preview.enabled") && com.intellij.openapi.util.registry.Registry.is("ide.browser.jcef.enabled"))) return
        def url = com.intellij.util.Urls.newFromEncoded("http://localhost:3000/search?a=1&b=2&q=\\"x\\\\y\\"")
        def dummy = new com.intellij.testFramework.LightVirtualFile("localhost:3000")
        def previewFile = new com.intellij.ide.browsers.actions.WebPreviewVirtualFile(dummy, url)
        com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFile(previewFile, true)
    } catch (Throwable t) {
        t.printStackTrace()
    }
}
`;

const GOLDEN_FRAG_DEFAULT = `if (!(com.intellij.openapi.util.registry.Registry.is("ide.web.preview.enabled") && com.intellij.openapi.util.registry.Registry.is("ide.browser.jcef.enabled"))) return
def url = com.intellij.util.Urls.newFromEncoded("http://h:1/x")
def dummy = new com.intellij.testFramework.LightVirtualFile("h:1")
def previewFile = new com.intellij.ide.browsers.actions.WebPreviewVirtualFile(dummy, url)
com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFile(previewFile, true)`;

// --- the launch/reap spy (runGroovy deps seam) ------------------------------

/** Capture the generated Groovy by injecting a launch spy that reads the temp. */
const captureDeps = (
  raises?: unknown,
): {
  deps: RunGroovyDeps;
  scripts: string[];
  calls: Array<{ args: string[]; wait: boolean }>;
  reaped: string[][];
  warned: string[];
} => {
  const scripts: string[] = [];
  const calls: Array<{ args: string[]; wait: boolean }> = [];
  const reaped: string[][] = [];
  const warned: string[] = [];
  return {
    scripts,
    calls,
    reaped,
    warned,
    deps: {
      launch: async (args, options) => {
        calls.push({ args, wait: options?.wait ?? false });
        scripts.push(await Bun.file(args[1] ?? "").text());
        if (raises !== undefined) throw raises;
        return {} as Bun.Subprocess;
      },
      reapLater: (paths) => {
        const list = [...paths];
        reaped.push(list);
        for (const p of list) void Bun.file(p).unlink?.();
      },
      warn: (line) => warned.push(line),
    },
  };
};

// --- happy path --------------------------------------------------------------

describe("setPreview", () => {
  test("runs ideScript blocking", async () => {
    const cap = captureDeps();
    await setPreview("/Users/me/notes.md", cap.deps);

    expect(cap.calls.length).toBe(1);
    expect(cap.calls[0]?.wait).toBe(true);
    expect(cap.calls[0]?.args[0]).toBe("ideScript");
    expect(cap.calls[0]?.args[1]?.endsWith(".groovy")).toBe(true);
  });

  test("GOLDEN: markdown route is byte-identical to Python", async () => {
    const cap = captureDeps();
    await setPreview("/Users/me/notes.md", cap.deps);
    expect(cap.scripts[0]).toBe(GOLDEN_SETLAYOUT_MD);
  });

  test("GOLDEN: HTML route is byte-identical to Python", async () => {
    const cap = captureDeps();
    await setPreview("/Users/me/page.html", cap.deps);
    expect(cap.scripts[0]).toBe(GOLDEN_WEBPREVIEW_HTML);
  });

  test("GOLDEN: escaped path (quote + backslash) is byte-identical to Python", async () => {
    const cap = captureDeps();
    await setPreview('/tmp/we"ird\\name.md', cap.deps);
    expect(cap.scripts[0]).toBe(GOLDEN_SETLAYOUT_ESCAPED);
  });

  test("non-HTML, non-previewable type still takes the setLayout route", async () => {
    const cap = captureDeps();
    await setPreview("/Users/me/snippet.py", cap.deps);
    const g = cap.scripts[0] ?? "";
    expect(g).toContain("SHOW_PREVIEW");
    expect(g).toContain("TextEditorWithPreview");
    expect(g).not.toContain("WebPreviewVirtualFile");
  });

  for (const path of ["/Users/me/PAGE.HTML", "/Users/me/index.Htm", "/Users/me/doc.XhTmL"]) {
    test(`HTML match is case-insensitive: ${path}`, async () => {
      const cap = captureDeps();
      await setPreview(path, cap.deps);
      const g = cap.scripts[0] ?? "";
      expect(g).toContain("WebPreviewVirtualFile");
      expect(g).not.toContain("SHOW_PREVIEW");
    });
  }

  test("schedules the temp for reap exactly once (same path as ideScript)", async () => {
    const cap = captureDeps();
    await setPreview("/Users/me/notes.md", cap.deps);
    expect(cap.reaped).toEqual([[cap.calls[0]?.args[1] ?? ""]]);
  });

  for (const [id, err] of [
    ["no-ide", new IdeaError("no JetBrains IDE in the process ancestry")],
    ["unimplemented-platform", new NotImplementedError("resolveExecPath is not implemented for Linux yet")],
    ["os-error", Object.assign(new Error("launcher missing"), { code: "ENOENT" })],
  ] as const) {
    for (const path of ["/Users/me/notes.md", "/Users/me/page.html"]) {
      test(`degrades without throwing (${id}, ${path})`, async () => {
        const cap = captureDeps(err);
        await expect(setPreview(path, cap.deps)).resolves.toBeUndefined();
        expect(cap.warned.join("")).toContain("preview:");
        expect(cap.reaped.length).toBe(1);
      });
    }
  }
});

// --- previewUrl --------------------------------------------------------------

describe("previewUrl", () => {
  test("runs ideScript blocking", async () => {
    const cap = captureDeps();
    await previewUrl("http://localhost:3000", undefined, cap.deps);
    expect(cap.calls.length).toBe(1);
    expect(cap.calls[0]?.wait).toBe(true);
    expect(cap.calls[0]?.args[0]).toBe("ideScript");
    expect(cap.calls[0]?.args[1]?.endsWith(".groovy")).toBe(true);
  });

  test("GOLDEN: host:port default title is byte-identical to Python", async () => {
    const cap = captureDeps();
    await previewUrl("http://localhost:3000", undefined, cap.deps);
    expect(cap.scripts[0]).toBe(GOLDEN_URL_HOSTPORT);
  });

  test("GOLDEN: query string + quote/backslash escaping is byte-identical to Python", async () => {
    const cap = captureDeps();
    await previewUrl('http://localhost:3000/search?a=1&b=2&q="x\\y"', undefined, cap.deps);
    expect(cap.scripts[0]).toBe(GOLDEN_URL_QUERY_SPECIALS);
  });

  test("default title is host-only when no port", async () => {
    const cap = captureDeps();
    await previewUrl("https://example.com/docs", undefined, cap.deps);
    expect(cap.scripts[0]).toContain('new com.intellij.testFramework.LightVirtualFile("example.com")');
  });

  test("title falls back to the full URL when host can't be parsed", async () => {
    const cap = captureDeps();
    await previewUrl("http://", undefined, cap.deps);
    expect(cap.scripts[0]).toContain('new com.intellij.testFramework.LightVirtualFile("http://")');
  });

  test("explicit title overrides the derived host:port", async () => {
    const cap = captureDeps();
    await previewUrl("http://localhost:3000", "My Dev Server", cap.deps);
    const g = cap.scripts[0] ?? "";
    expect(g).toContain('new com.intellij.testFramework.LightVirtualFile("My Dev Server")');
    // The derived label is NOT used (only the embedded URL mentions localhost:3000).
    expect(g.replaceAll("http://localhost:3000", "")).not.toContain("localhost:3000");
  });

  test("schedules the temp for reap exactly once", async () => {
    const cap = captureDeps();
    await previewUrl("http://localhost:3000", undefined, cap.deps);
    expect(cap.reaped).toEqual([[cap.calls[0]?.args[1] ?? ""]]);
  });

  for (const [id, err] of [
    ["no-ide", new IdeaError("no JetBrains IDE in the process ancestry")],
    ["unimplemented-platform", new NotImplementedError("resolveExecPath is not implemented for Linux yet")],
    ["os-error", Object.assign(new Error("launcher missing"), { code: "ENOENT" })],
  ] as const) {
    test(`degrades without throwing (${id})`, async () => {
      const cap = captureDeps(err);
      await expect(previewUrl("http://localhost:3000", undefined, cap.deps)).resolves.toBeUndefined();
      expect(cap.warned.join("")).toContain("preview:");
      expect(cap.reaped.length).toBe(1);
    });
  }
});

// --- the shared fragment (single source of truth) ---------------------------

describe("webpreviewOpenBody", () => {
  test("GOLDEN: default (no indent, project var) is byte-identical to Python", () => {
    expect(webpreviewOpenBody("http://h:1/x", "h:1")).toBe(GOLDEN_FRAG_DEFAULT);
  });

  test("indent prefixes every line", () => {
    const out = webpreviewOpenBody("http://h:1/x", "h:1", { indent: " ".repeat(8) });
    for (const line of out.split("\n")) {
      expect(line.startsWith("        ")).toBe(true);
    }
  });

  test("projectVar fills the getInstance(...) target", () => {
    const out = webpreviewOpenBody("http://h", "h", { projectVar: "proj" });
    expect(out).toContain("getInstance(proj)");
  });
});
