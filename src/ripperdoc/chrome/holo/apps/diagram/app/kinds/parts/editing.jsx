// editing.jsx — the shared inline-editing primitives every diagram node kind composes.
//
// Extracted from ClassNode.jsx so each kind ships the same editing grammar —
// click a token to open a one-shot <input>, Enter or blur commits, Escape
// reverts — without re-deriving the React Flow input-safety rules. Every
// interactive element here is `nodrag nopan` and stops pointer/key propagation
// so the canvas never pans, drags, or Backspace-deletes the node mid-edit.
import { useEffect, useRef, useState } from "react";

/** The one monospace stack every kind's code-ish text uses. */
export const MONO = 'ui-monospace, "JetBrains Mono", Menlo, monospace';

// Shared chrome for the inline editors: transparent so the box colour shows
// through, font inherited from the slot it replaces (bold sans for a node
// name, monospace for members), width tracks content via the `size` attribute.
export const editInputStyle = {
  font: "inherit",
  color: "var(--fg)",
  background: "transparent",
  border: "none",
  borderRadius: 3,
  padding: 0,
  margin: 0,
  outline: "none",
  height: "1em",
  fieldSizing: "content",
  boxSizing: "border-box",
};
export const nameInputStyle = { ...editInputStyle, textAlign: "center" };

// Hint that a static token opens an editor on click; ghost marks an empty
// value's muted affordance (e.g. the lone `:` inviting a type).
const editableStyle = { cursor: "text" };
const ghostStyle = { color: "var(--muted)" };

// The muted "+ member" affordance at the foot of a compartment.
const addRowStyle = {
  padding: "3px 10px",
  color: "var(--muted)",
  cursor: "pointer",
  fontStyle: "italic",
  fontSize: 11,
};

// A hover-revealed remove "×" at the right edge of a row.
const removeBtnStyle = {
  flex: "none",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  font: "inherit",
  lineHeight: 1,
  padding: 0,
};

/**
 * A one-shot inline text editor. Mounts already focused with its text selected;
 * commits on Enter or blur, reverts on Escape. `done` guards the Enter→blur
 * double fire (committing on Enter unmounts the input, which also blurs it). The
 * input is marked nodrag/nopan and stops every pointer/key event so React Flow
 * doesn't pan, drag, or Backspace-delete the node while you type.
 */
export function Editor({ initial, onCommit, onCancel, style }) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef(null);
  const done = useRef(false);
  // Focus + select ONCE on mount. An inline ref callback re-runs every render (new
  // identity), re-selecting the text after each keystroke so the next key overwrites
  // it — that was the single-letter bug.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const finish = (commit) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };
  return (
    <input
      className="nodrag nopan"
      ref={inputRef}
      value={value}
      size={Math.max(value.length + 1, 3)}
      style={style}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => finish(true)}
    />
  );
}

/**
 * The `editing ? <Editor/> : clickable token` pair. `value` is what the editor
 * edits; `display` is the static rendering when it differs (e.g. `(params)`
 * around a params value, `: type` around a type). `prefix`/`suffix` wrap the
 * OPEN editor with the literal chrome the display kept (so `(` + input + `)`
 * reads as the token being edited in place). `ghost` mutes an empty value's
 * affordance.
 */
export function EditableText({
  editing,
  value,
  display,
  prefix = "",
  suffix = "",
  ghost = false,
  onEdit,
  onCommit,
  onCancel,
  inputStyle = editInputStyle,
  style,
}) {
  if (editing) {
    return (
      <>
        {prefix}
        <Editor initial={value} onCommit={onCommit} onCancel={onCancel} style={inputStyle} />
        {suffix}
      </>
    );
  }
  return (
    <span style={{ ...editableStyle, ...(ghost ? ghostStyle : null), ...style }} onClick={onEdit}>
      {display ?? value}
    </span>
  );
}

/** A clickable glyph that cycles a fixed value list — the caller owns the order, this owns the input safety. */
export function CycleGlyph({ value, color, title, onCycle, style }) {
  return (
    <span
      className="nodrag nopan"
      style={{ cursor: "pointer", color, ...style }}
      title={title}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onCycle();
      }}
    >
      {value}
    </span>
  );
}

/** The muted italic "+ thing" row that appends a member and opens its editor. */
export function AddRow({ label, onAdd }) {
  return (
    <div
      className="nodrag nopan"
      style={addRowStyle}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onAdd();
      }}
    >
      {label}
    </div>
  );
}

/** The row-trailing remove "×"; `emphasized` is the row's hover state. */
export function RemoveX({ emphasized, title, onRemove, style }) {
  return (
    <button
      type="button"
      className="nodrag nopan"
      style={{
        ...removeBtnStyle,
        color: emphasized ? "var(--priv, #e5534b)" : "var(--muted)",
        opacity: emphasized ? 1 : 0.35,
        ...style,
      }}
      title={title}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onRemove();
      }}
    >
      ×
    </button>
  );
}
