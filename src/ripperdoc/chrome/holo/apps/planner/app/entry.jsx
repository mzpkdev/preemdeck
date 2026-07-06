// entry.jsx — the holo client. Renders the plan file in a WYSIWYG MDX editor
// (MDXEditor) so a human edits the *rendered* document directly. Every edit is
// debounced and POSTed back to holo's dev server, which writes it to the plan
// file on disk — so the on-disk .md/.mdx stays the canonical artifact the agent
// reads, while the browser is the editing surface.
import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  CodeToggle,
  CreateLink,
  codeBlockPlugin,
  codeMirrorPlugin,
  directivesPlugin,
  frontmatterPlugin,
  headingsPlugin,
  InsertCodeBlock,
  insertDirective$,
  InsertTable,
  InsertThematicBreak,
  linkDialogPlugin,
  linkPlugin,
  ListsToggle,
  listsPlugin,
  markdownShortcutPlugin,
  MDXEditor,
  quotePlugin,
  Separator,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  UndoRedo,
  useMdastNodeUpdater,
  useNestedEditorContext,
  usePublisher,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import * as Popover from "@radix-ui/react-popover";
import { PaperPlaneIcon } from "@radix-ui/react-icons";
import { $createTextNode, $getNodeByKey } from "lexical";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@holo-style";
// Loaded last so it wins the cascade: patches MDXEditor dark tokens (e.g. the
// hardcoded `--basePageBg: white`) that its own .dark-theme leaves light.
import "./editor-theme.css";
// The diagram app's zod contract — light (no elk/react-flow), so importing it
// eagerly to validate a spec costs nothing. The heavy canvas is lazy (see below).
// Cross-app relative import: planner's Vite roots at planner/app but allow-lists
// the repo root (serve.ts `server.fs.allow`), so `../../diagram/...` resolves and
// Vite/esbuild transpiles the .ts on the fly.
import { GraphSpec } from "../../diagram/app/kinds/schema";

/** The endpoint holo's dev server mounts: GET seeds the editor, POST persists an edit. */
const PLAN_ENDPOINT = "/__holo/plan";

/** GET: is this serve an approval gate (`--wait`), and under which nonce. */
const GATE_ENDPOINT = "/__holo/gate";

/** POST `{ verdict, nonce }`: render the reviewer's verdict; the server prints it and exits. */
const VERDICT_ENDPOINT = "/__holo/verdict";

/** Debounce window (ms) between the last keystroke and the write-back POST. */
const SAVE_DEBOUNCE_MS = 300;

/** Fenced-code languages CodeMirror highlights; the key is the ```lang token. */
const CODE_LANGUAGES = {
  txt: "Text",
  js: "JavaScript",
  jsx: "JSX",
  ts: "TypeScript",
  tsx: "TSX",
  json: "JSON",
  bash: "Shell",
  sh: "Shell",
  css: "CSS",
  html: "HTML",
  md: "Markdown",
  py: "Python",
};

/**
 * Whether the ACTIVE stylesheet paints a dark page. Reads holo's own `--bg`
 * custom property (both bundled stylesheets define it) rather than
 * `prefers-color-scheme` — the IDE's JCEF preview reports the media query
 * unreliably — and falls back to the computed body background. Call it AFTER mount:
 * reading at module-eval races Vite's async CSS injection (MDXEditor's own light
 * CSS wins the instant you measure), which is what left the chrome/popovers light.
 */
const readPaletteIsDark = () => {
  const luminance = (r, g, b) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  const hex = bg.startsWith("#") ? bg.slice(1) : "";
  if (hex.length === 3 || hex.length === 6) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    return (
      luminance(
        Number.parseInt(full.slice(0, 2), 16),
        Number.parseInt(full.slice(2, 4), 16),
        Number.parseInt(full.slice(4, 6), 16),
      ) < 0.5
    );
  }
  const rgb = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
  return rgb ? luminance(Number(rgb[0]), Number(rgb[1]), Number(rgb[2])) < 0.5 : false;
};

// Fenced code renders in CodeMirror, which ignores holo's --css and defaults to a
// light theme (white background). Re-theme its container to the page's palette
// variables so it tracks whatever stylesheet is active.
const CODE_MIRROR_THEME_SPEC = {
  "&": { backgroundColor: "var(--code-bg)", color: "var(--fg)", fontSize: "12px" },
  ".cm-gutters": { backgroundColor: "var(--code-bg)", color: "var(--muted)", border: "none" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--fg)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--selection, rgba(84, 174, 255, 0.25))",
  },
  // Clicking/selecting a token highlights every match (.cm-selectionMatch) and search
  // hits (.cm-searchMatch); both default to a light box — tie them to the palette so
  // they don't flash white on a dark page.
  ".cm-selectionMatch": { backgroundColor: "var(--selection, rgba(84, 174, 255, 0.25))" },
  ".cm-searchMatch": { backgroundColor: "var(--selection, rgba(84, 174, 255, 0.25))" },
  // The bracket-match decoration defaults to a bright box; tie it to the palette.
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--selection, rgba(84, 174, 255, 0.25))",
    color: "var(--fg)",
    outline: "1px solid var(--border, transparent)",
  },
  ".cm-nonmatchingBracket": { color: "var(--code-error, #e5534b)", backgroundColor: "transparent" },
};

// Syntax token colors come from the active stylesheet's --code-* custom properties
// so fenced code tracks whatever --css holo resolved; the fallbacks are the Darcula
// (IntelliJ New UI) palette, so a sheet that omits a token still reads correctly.
const codeMirrorTokens = syntaxHighlighting(
  HighlightStyle.define([
    {
      tag: [t.keyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword],
      color: "var(--code-keyword, #cf8e6d)",
    },
    { tag: [t.string, t.special(t.string), t.regexp], color: "var(--code-string, #6aab73)" },
    { tag: [t.number, t.bool, t.null], color: "var(--code-number, #2aacb8)" },
    {
      tag: [t.comment, t.lineComment, t.blockComment],
      color: "var(--code-comment, var(--muted))",
      fontStyle: "italic",
    },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--code-fn, #56a8f5)" },
    { tag: [t.typeName, t.className, t.tagName], color: "var(--code-type, #b5b6e3)" },
    { tag: [t.propertyName, t.attributeName], color: "var(--code-property, #c77dbb)" },
    { tag: [t.variableName, t.punctuation, t.operator, t.bracket], color: "var(--fg)" },
  ]),
);

/** Build the CodeMirror extensions for the resolved theme: palette-driven container + syntax tokens. */
const buildCodeMirrorExtensions = (dark) => {
  const theme = EditorView.theme(CODE_MIRROR_THEME_SPEC, { dark });
  return [theme, codeMirrorTokens];
};

// --- LLM annotations -------------------------------------------------------
// Notes for the agent ride IN the plan file as an `llm-note` remark directive.
// HTML comments don't survive MDXEditor's round-trip (its parser silently drops
// them); a directive node clones its mdast and re-emits it verbatim, so
// `:llm-note{…}` persists through import→edit→export. The agent reads them when it
// resumes at the plan gate — no live channel needed — by grepping `:llm-note` from
// the .md/.mdx on disk.

/** The directive name — the greppable token in the plan file. */
const LLM_NOTE = "llm-note";

// The note popover IS a single input-with-button control — no surrounding card. The
// Content just positions; GROUP_STYLE carries the border/radius/shadow, INPUT is
// borderless inside it, and SEND is an embedded icon button behind a divider.
const CONTENT_STYLE = { zIndex: 60 };
const GROUP_STYLE = {
  display: "flex",
  alignItems: "stretch",
  width: "240px",
  font: "13px -apple-system, system-ui, sans-serif",
  color: "var(--fg)",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  boxShadow: "0 8px 24px rgba(0, 0, 0, 0.35)",
  overflow: "hidden",
};
const INPUT_STYLE = {
  flex: 1,
  minWidth: 0,
  padding: "6px 10px",
  font: "inherit",
  color: "var(--fg)",
  background: "transparent",
  border: "none",
  outline: "none",
};
const SEND_STYLE = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "none",
  width: "32px",
  cursor: "pointer",
  border: "none",
  borderLeft: "1px solid var(--border)",
};
const SEND_ICON = <PaperPlaneIcon width={15} height={15} />;

/**
 * Single-line note input + icon send, shared by create (NoteAnnotator) and edit
 * (LlmNoteEditor). Autofocuses; Enter submits, Escape cancels. Keydowns stop
 * propagating so they don't leak through the Radix portal into MDXEditor (which
 * would drop a newline / stray chars into the plan). Quotes are neutralized so a
 * stray one can't break the directive's attribute syntax.
 */
const NoteForm = ({ initial = "", onSubmit, onCancel }) => {
  const [body, setBody] = useState(initial);
  const inputRef = useRef(null);
  useEffect(() => {
    const id = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, []);
  const send = () => {
    // Always submit — even empty; the edit popover treats empty as "remove note".
    onSubmit(body.trim().replace(/"/g, "'"));
  };
  return (
    <div style={GROUP_STYLE}>
      <input
        ref={inputRef}
        type="text"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            send();
          } else if (event.key === "Escape") {
            onCancel?.();
          }
        }}
        placeholder="Note for the LLM…"
        style={INPUT_STYLE}
      />
      <button
        type="button"
        className="holo-note-send"
        onClick={send}
        title="Save note"
        aria-label="Save note"
        style={SEND_STYLE}
      >
        {SEND_ICON}
      </button>
    </div>
  );
};

/**
 * Renders an `llm-note` directive as a highlighter background over the wrapped text —
 * the content stays visible, just marked. Hover shows the note (native title); click
 * opens a popover to edit the note body (written back to the `note` attribute via
 * useMdastNodeUpdater; the wrapped text is untouched). Text is display-only.
 */
const LlmNoteEditor = ({ mdastNode }) => {
  const { note = "" } = mdastNode.attributes ?? {};
  const text = (mdastNode.children ?? []).map((child) => child.value ?? "").join("");
  const updateMdastNode = useMdastNodeUpdater();
  const { parentEditor, lexicalNode } = useNestedEditorContext();
  const [open, setOpen] = useState(false);
  const save = (next) => {
    if (next) {
      updateMdastNode({ attributes: { note: next } });
    } else {
      // Empty on edit → unwrap: replace the directive with its plain text, dropping the note.
      parentEditor.update(() => {
        $getNodeByKey(lexicalNode.getKey())?.replace($createTextNode(text));
      });
    }
    setOpen(false);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <span
          className="llm-note-mark"
          title={note || "note"}
          style={{
            background: "var(--note-highlight, rgba(255, 213, 0, 0.32))",
            borderRadius: "2px",
            padding: "0 2px",
            cursor: "pointer",
          }}
        >
          {text}
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          onOpenAutoFocus={(event) => event.preventDefault()}
          style={CONTENT_STYLE}
        >
          <NoteForm initial={note} onSubmit={save} onCancel={() => setOpen(false)} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};

/** Registers `llm-note` so directivesPlugin preserves it on round-trip and renders the highlight. */
const llmNoteDescriptor = {
  name: LLM_NOTE,
  testNode: (node) => node.name === LLM_NOTE,
  attributes: ["note"],
  hasChildren: true,
  Editor: LlmNoteEditor,
};

/**
 * Hidden agent-instruction preamble (a `:::llm-guide` container directive). Its Editor
 * renders NOTHING, so it's invisible in holo, but directivesPlugin still preserves the
 * node + children on round-trip — so the prose stays in the .md for the agent to grep.
 * Injected once by plan-preview when it materializes an interactive plan (not authored
 * by the user), so there's no create/edit UI for it here.
 */
const llmGuideDescriptor = {
  name: "llm-guide",
  testNode: (node) => node.name === "llm-guide",
  attributes: [],
  hasChildren: true,
  Editor: () => null,
};

// --- Embedded diagram (class + component/architecture) ----------------------
// An editable diagram rides IN the plan file as a `:::diagram` CONTAINER directive
// wrapping ONE ```json fenced child that holds the pretty GraphSpec. Carrier choice
// (code child, not a `spec` attribute): a directive node stores its mdast verbatim
// and re-emits it verbatim on export (same as llm-guide), and mdast-util-directive
// round-trips `:::diagram` + a ```json child byte-faithfully — whereas a container
// directive's `{attr="…"}` block must be single-line, so pretty (multi-line) JSON in
// an attribute breaks the directive syntax outright. So the spec lives in the code
// child: read `code.value`, write it back on edit.
const DIAGRAM = "diagram";

// The canvas pulls react-flow + elkjs (heavy). Lazy-load it so a plan with NO
// `:::diagram` never fetches that chunk; GraphSpec (above) stays eager + light.
const DiagramCanvas = lazy(() =>
  import("../../diagram/app/DiagramCanvas").then((module) => ({ default: module.DiagramCanvas })),
);

/** Rendered height of the embedded canvas — React Flow measures its parent, so the wrapper must be sized. */
const DIAGRAM_HEIGHT = 460;

/** Inline error style for a bad spec — legible on any `--css` (planner's sheet may not define `.holo-error`). */
const DIAGRAM_ERROR_STYLE = {
  display: "block",
  padding: "8px 12px",
  font: "12px ui-monospace, SFMono-Regular, Menlo, monospace",
  color: "var(--code-error, #e5534b)",
};

/**
 * Read + validate the graph spec from the directive's carrier: the first ```json
 * (code) child's value, JSON-parsed then run through the zod contract. Returns a
 * tagged result so the Editor renders either the canvas or an inline error.
 */
const parseDiagramSpec = (mdastNode) => {
  const code = (mdastNode.children ?? []).find((child) => child.type === "code");
  if (!code) {
    return { ok: false, message: "no ```json spec inside :::diagram" };
  }
  let raw;
  try {
    raw = JSON.parse(code.value);
  } catch (error) {
    return { ok: false, message: `spec is not valid JSON — ${String(error)}` };
  }
  const parsed = GraphSpec.safeParse(raw);
  return parsed.success ? { ok: true, spec: parsed.data } : { ok: false, message: parsed.error.message };
};

/**
 * Renders a `:::diagram` directive as an embedded, editable DiagramCanvas. The spec
 * is parsed ONCE from the carrier at mount (via useState initializer) so the `spec`
 * prop keeps a stable identity across our own write-backs — otherwise every edit
 * would re-seed and re-run the canvas's ELK layout. Edits flow out through
 * `onChange`: serialize the rebuilt spec and write it back into the code child via
 * useMdastNodeUpdater; MDXEditor's debounced onChange then POSTs the whole .md to
 * planner's /__holo/plan (no POST here — same as llm-note).
 */
const DiagramEditor = ({ mdastNode }) => {
  const updateMdastNode = useMdastNodeUpdater();
  // Freshest updater behind a ref so `onChange` keeps a stable identity (won't
  // re-trigger the canvas's emit effect); the updater merges over the node, so
  // replacing `children` wholesale never disturbs `name`/`type`.
  const updaterRef = useRef(updateMdastNode);
  updaterRef.current = updateMdastNode;
  const [parsed] = useState(() => parseDiagramSpec(mdastNode));

  // Inert until clicked: react-flow preventDefault()s wheel for its zoom, so a canvas
  // met mid-scroll would hijack the page. While inactive an overlay swallows all
  // pointer interaction and lets wheel bubble to the page scroll; a click arms the
  // canvas (border tint signals it), a pointerdown outside disarms it.
  const [active, setActive] = useState(false);
  const frameRef = useRef(null);

  useEffect(() => {
    if (!active) {
      return;
    }
    const disarm = (event) => {
      if (!frameRef.current?.contains(event.target)) {
        setActive(false);
      }
    };
    document.addEventListener("pointerdown", disarm);
    return () => document.removeEventListener("pointerdown", disarm);
  }, [active]);

  const onChange = useCallback((nextSpec) => {
    updaterRef.current({
      children: [{ type: "code", lang: "json", meta: null, value: JSON.stringify(nextSpec, null, 2) }],
    });
  }, []);

  if (!parsed.ok) {
    return (
      <span className="holo-error" style={DIAGRAM_ERROR_STYLE}>
        holo: {parsed.message}
      </span>
    );
  }
  return (
    <Suspense fallback={<div style={DIAGRAM_ERROR_STYLE}>loading diagram…</div>}>
      <div
        ref={frameRef}
        className={active ? "holo-diagram holo-diagram--armed" : "holo-diagram"}
        style={{
          position: "relative",
          height: DIAGRAM_HEIGHT,
          border: `1px solid ${active ? "var(--accent, #4c8ffb)" : "var(--border)"}`,
          borderRadius: "6px",
          overflow: "hidden",
        }}
      >
        <DiagramCanvas spec={parsed.spec} onChange={onChange} />
        {!active && (
          <div
            title="Click to edit the diagram"
            onClick={() => setActive(true)}
            style={{ position: "absolute", inset: 0, zIndex: 10, cursor: "pointer" }}
          />
        )}
      </div>
    </Suspense>
  );
};

/** Registers `:::diagram` so directivesPlugin preserves it on round-trip and renders the canvas. */
const diagramDescriptor = {
  name: DIAGRAM,
  testNode: (node) => node.name === DIAGRAM,
  attributes: [],
  hasChildren: true,
  Editor: DiagramEditor,
};

/**
 * Right-click-with-selection → new-note popover. A contextmenu inside the editable
 * content with a live text selection suppresses the native menu and opens a Radix
 * popover at the cursor. The selection becomes the note's `anchor` (a quoted snippet
 * the agent relocates by search, not a fragile offset); NoteForm captures the body
 * and inserts an `llm-note` text directive — the round-trip-safe carrier.
 *
 * Radix Popover (already present via MDXEditor) rather than shadcn+Tailwind: the same
 * primitive shadcn wraps, styled with holo's palette vars so it matches every --css.
 */
const NoteAnnotator = () => {
  const insert = usePublisher(insertDirective$);
  const [target, setTarget] = useState(null); // { x, y, anchor } | null

  useEffect(() => {
    const onContextMenu = (event) => {
      if (!event.target.closest?.(".mdxeditor-root-contenteditable")) {
        return; // outside the editable: leave the native menu alone
      }
      const anchor = (window.getSelection()?.toString() ?? "").trim();
      if (!anchor) {
        return; // no selection: no annotation, native menu stands
      }
      event.preventDefault();
      setTarget({ x: event.clientX, y: event.clientY, anchor });
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  const close = () => setTarget(null);
  const add = (note) => {
    // Empty → create nothing. Otherwise wrap the selected text as the directive's
    // children so the content stays in the document (a highlight), not replaced.
    if (note) {
      insert({
        type: "textDirective",
        name: LLM_NOTE,
        children: [{ type: "text", value: target.anchor }],
        attributes: { note },
      });
    }
    close();
  };

  // This component's DOM home is the toolbar, whose slide-away `transform` makes it
  // the containing block for `position: fixed` children — a fixed Anchor element here
  // lands scrollTop pixels above the cursor. A virtual anchor is only measured, never
  // laid out, so no ancestor transform can displace it.
  const anchorRef = useMemo(
    () => ({ current: { getBoundingClientRect: () => new DOMRect(target?.x ?? 0, target?.y ?? 0, 0, 0) } }),
    [target],
  );

  return (
    <Popover.Root open={target !== null} onOpenChange={(open) => !open && close()}>
      <Popover.Anchor virtualRef={anchorRef} />
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          onOpenAutoFocus={(event) => event.preventDefault()}
          style={CONTENT_STYLE}
        >
          {target ? <NoteForm initial="" onSubmit={add} onCancel={close} /> : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};

function Holo() {
  // null until the initial GET resolves — MDXEditor reads its initial content
  // from `markdown` once at mount, so we render it only after the fetch lands.
  const [markdown, setMarkdown] = useState(null);
  // Resolved after mount (readPaletteIsDark); drives MDXEditor's dark chrome and
  // the <html> class that reaches its body-portaled dropdowns/popovers.
  const [dark, setDark] = useState(false);
  // null until the gate probe lands; then `{ waiting, nonce }` and, once a
  // verdict is posted, `sent: "approve" | "reject"`. The bar renders only when
  // the serve is actually gating (`--wait`).
  const [gate, setGate] = useState(null);
  const saveTimer = useRef(undefined);
  // The latest edit not yet confirmed by a completed POST. Held so a teardown can
  // persist it synchronously instead of dropping it: the JCEF preview tab reloads
  // itself mid-edit (focus/repaint), and a reload inside the debounce window would
  // otherwise cancel the pending POST AND re-seed the editor from the stale file,
  // silently reverting the edit. `null` means nothing outstanding.
  const pending = useRef(null);
  // Whether the CURRENT document carries reviewer notes (`:llm-note`), tracked
  // live from the initial fetch and every edit. The verdict follows from it:
  // notes present → the one honest button is "Request changes"; a clean doc →
  // "Approve". Leaving a note IS the rejection rationale.
  const [hasNotes, setHasNotes] = useState(false);
  // The revision tag holds the accent color until the reviewer hovers it — an
  // unhovered tag means the update may not have been noticed yet.
  const [revSeen, setRevSeen] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(GATE_ENDPOINT)
      .then((response) => (response.ok ? response.json() : null))
      .then((state) => {
        if (live && state?.waiting) {
          setGate(state);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // A verdict must never race the debounced save: flush the outstanding edit with
  // an AWAITED POST (the teardown beacon gives no completion signal), then post
  // the verdict with this serve's nonce. The server prints the verdict and exits;
  // the badge tells the reviewer this page is done.
  const sendVerdict = async (verdict) => {
    clearTimeout(saveTimer.current);
    const text = pending.current;
    pending.current = null;
    if (text !== null) {
      await fetch(PLAN_ENDPOINT, { method: "POST", body: text });
    }
    const response = await fetch(VERDICT_ENDPOINT, {
      method: "POST",
      body: JSON.stringify({ verdict, nonce: gate.nonce }),
    });
    if (response.ok) {
      setGate({ ...gate, sent: verdict });
    }
  };

  useEffect(() => {
    const isDark = readPaletteIsDark();
    setDark(isDark);
    // MDXEditor portals its dropdowns/popovers into a container on document.body,
    // so the `.dark-theme` token cascade (pure CSS vars, no descendant selectors)
    // reaches them only from a shared ancestor — put the class on <html>.
    document.documentElement.classList.toggle("dark-theme", isDark);

    let live = true;
    fetch(PLAN_ENDPOINT)
      .then((response) => response.text())
      .then((text) => {
        if (live) {
          setMarkdown(text);
          setHasNotes(text.includes(":llm-note"));
        }
      });

    // Persist the outstanding edit NOW, synchronously. sendBeacon survives page
    // teardown and isn't throttled in a hidden page (a plain fetch is cancelled on
    // unload); keepalive fetch is the fallback if the beacon is refused (e.g. an
    // over-large payload). Runs on the events that precede a JCEF reload/tab-hide and
    // on unmount, so an in-flight edit is flushed rather than lost to the reload race.
    const flush = () => {
      clearTimeout(saveTimer.current);
      const text = pending.current;
      if (text === null) {
        return;
      }
      pending.current = null;
      const sent = navigator.sendBeacon?.(PLAN_ENDPOINT, text);
      if (!sent) {
        void fetch(PLAN_ENDPOINT, { method: "POST", body: text, keepalive: true });
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        flush();
      }
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      live = false;
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
    };
  }, []);

  const codeMirrorExtensions = useMemo(() => buildCodeMirrorExtensions(dark), [dark]);

  if (markdown === null) {
    return null;
  }

  // Debounce the write-back so a burst of keystrokes collapses to one POST.
  const save = (next) => {
    // Track the outstanding text so a teardown flush can persist it; keep it set until
    // the POST resolves, so a reload between timer-fire and completion still re-sends it.
    pending.current = next;
    setHasNotes(next.includes(":llm-note"));
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void fetch(PLAN_ENDPOINT, { method: "POST", body: next }).then(() => {
        if (pending.current === next) {
          pending.current = null;
        }
      });
    }, SAVE_DEBOUNCE_MS);
  };

  return (
    <>
      {gate ? (
        <div className="holo-gate">
          {gate.revision > 1 ? (
            <span
              className={revSeen ? "holo-gate__rev holo-gate__rev--seen" : "holo-gate__rev"}
              onMouseEnter={() => setRevSeen(true)}
            >
              Revision {gate.revision}
            </span>
          ) : null}
          {(gate.sent ?? (hasNotes ? "reject" : "approve")) === "reject" ? (
            <button
              type="button"
              className="holo-gate__reject"
              title="Send your notes back to the agent"
              disabled={Boolean(gate.sent)}
              onClick={() => void sendVerdict("reject")}
            >
              ↺ Rework
            </button>
          ) : (
            <button
              type="button"
              className="holo-gate__approve"
              title="Approve the plan"
              disabled={Boolean(gate.sent)}
              onClick={() => void sendVerdict("approve")}
            >
              ✓ Approve
            </button>
          )}
        </div>
      ) : null}
      <MDXEditor
        markdown={markdown}
        onChange={save}
        className={dark ? "dark-theme dark-editor" : undefined}
        contentEditableClassName="holo-plan"
        plugins={[
          headingsPlugin(),
          listsPlugin(),
          quotePlugin(),
          tablePlugin(),
          linkPlugin(),
          linkDialogPlugin(),
          thematicBreakPlugin(),
          frontmatterPlugin(),
          codeBlockPlugin({ defaultCodeBlockLanguage: "txt" }),
          codeMirrorPlugin({ codeBlockLanguages: CODE_LANGUAGES, codeMirrorExtensions }),
          markdownShortcutPlugin(),
          directivesPlugin({ directiveDescriptors: [llmNoteDescriptor, llmGuideDescriptor, diagramDescriptor] }),
          toolbarPlugin({
            toolbarContents: () => (
              <>
                <UndoRedo />
                <Separator />
                <BoldItalicUnderlineToggles />
                <CodeToggle />
                <Separator />
                <BlockTypeSelect />
                <ListsToggle />
                <Separator />
                <CreateLink />
                <InsertTable />
                <InsertThematicBreak />
                <InsertCodeBlock />
                <NoteAnnotator />
              </>
            ),
          }),
        ]}
      />
    </>
  );
}

createRoot(document.getElementById("root")).render(<Holo />);
