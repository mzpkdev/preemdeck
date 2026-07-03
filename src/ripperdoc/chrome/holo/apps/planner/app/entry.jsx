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
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@holo-style";
// Loaded last so it wins the cascade: patches MDXEditor dark tokens (e.g. the
// hardcoded `--basePageBg: white`) that its own .dark-theme leaves light.
import "./editor-theme.css";

/** The endpoint holo's dev server mounts: GET seeds the editor, POST persists an edit. */
const PLAN_ENDPOINT = "/__holo/plan";

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

  return (
    <Popover.Root open={target !== null} onOpenChange={(open) => !open && close()}>
      <Popover.Anchor style={{ position: "fixed", left: target?.x ?? 0, top: target?.y ?? 0, width: 0, height: 0 }} />
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
  const saveTimer = useRef(undefined);

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
        }
      });
    return () => {
      live = false;
      clearTimeout(saveTimer.current);
    };
  }, []);

  const codeMirrorExtensions = useMemo(() => buildCodeMirrorExtensions(dark), [dark]);

  if (markdown === null) {
    return null;
  }

  // Debounce the write-back so a burst of keystrokes collapses to one POST.
  const save = (next) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void fetch(PLAN_ENDPOINT, { method: "POST", body: next });
    }, SAVE_DEBOUNCE_MS);
  };

  return (
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
        directivesPlugin({ directiveDescriptors: [llmNoteDescriptor, llmGuideDescriptor] }),
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
  );
}

createRoot(document.getElementById("root")).render(<Holo />);
