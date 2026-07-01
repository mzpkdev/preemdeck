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
  frontmatterPlugin,
  headingsPlugin,
  InsertCodeBlock,
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
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
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
    return luminance(Number.parseInt(full.slice(0, 2), 16), Number.parseInt(full.slice(2, 4), 16), Number.parseInt(full.slice(4, 6), 16)) < 0.5;
  }
  const rgb = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
  return rgb ? luminance(Number(rgb[0]), Number(rgb[1]), Number(rgb[2])) < 0.5 : false;
};

// Fenced code renders in CodeMirror, which ignores holo's --css and defaults to a
// light theme (white background). Re-theme its container to the page's palette
// variables so it tracks whatever stylesheet is active.
const CODE_MIRROR_THEME_SPEC = {
  "&": { backgroundColor: "var(--code-bg)", color: "var(--fg)" },
  ".cm-gutters": { backgroundColor: "var(--code-bg)", color: "var(--muted)", border: "none" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--fg)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--selection, rgba(84, 174, 255, 0.25))",
  },
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
    { tag: [t.keyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], color: "var(--code-keyword, #cf8e6d)" },
    { tag: [t.string, t.special(t.string), t.regexp], color: "var(--code-string, #6aab73)" },
    { tag: [t.number, t.bool, t.null], color: "var(--code-number, #2aacb8)" },
    { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--code-comment, var(--muted))", fontStyle: "italic" },
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
            </>
          ),
        }),
      ]}
    />
  );
}

createRoot(document.getElementById("root")).render(<Holo />);
