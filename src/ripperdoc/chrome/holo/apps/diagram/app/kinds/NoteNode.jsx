// NoteNode.jsx — the UML note: verbatim code/prose in a folded-corner monospace
// box, tied to its owner by a `kind:"note"` edge (dashed, no marker). `text` is
// one multiline token; click opens the vocabulary's one multiline editor — a
// textarea where Enter inserts a newline, Cmd/Ctrl+Enter or blur commits, and
// Escape reverts. Width is capped so a long expression wraps instead of
// stretching the whole ELK layout.
import { useReactFlow } from "@xyflow/react";
import { memo, useEffect, useRef, useState } from "react";
import { MONO } from "./parts/editing";
import { NodeShell } from "./parts/NodeShell";

const NOTE_MAX_WIDTH = 320;

const noteStyle = {
  padding: "8px 12px",
  borderRadius: "6px 0 6px 6px",
  fontFamily: MONO,
  fontSize: 11,
  lineHeight: 1.55,
  whiteSpace: "pre-wrap",
  overflowWrap: "break-word",
  width: "max-content",
  maxWidth: NOTE_MAX_WIDTH,
};

// The folded top-right corner: a canvas-coloured square whose two inner sides
// carry the border, punching the classic UML dog-ear out of the box.
const foldStyle = {
  position: "absolute",
  top: 0,
  right: 0,
  width: 12,
  height: 12,
  background: "var(--bg)",
  borderLeft: "1px solid var(--border)",
  borderBottom: "1px solid var(--border)",
};

const textareaStyle = {
  font: "inherit",
  color: "var(--fg)",
  background: "transparent",
  border: "none",
  outline: "none",
  padding: 0,
  margin: 0,
  resize: "none",
  width: NOTE_MAX_WIDTH - 24,
  minHeight: "3em",
};

const ghostStyle = { color: "var(--muted)", fontStyle: "italic" };

/**
 * The multiline sibling of parts/editing's one-shot <input> Editor: same
 * focus/commit/revert grammar and React Flow input-safety, but Enter stays a
 * newline (Cmd/Ctrl+Enter commits) because note text is verbatim.
 */
function NoteEditor({ initial, onCommit, onCancel }) {
  const [value, setValue] = useState(initial);
  const ref = useRef(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (commit) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };
  return (
    <textarea
      className="nodrag nopan"
      ref={ref}
      value={value}
      style={textareaStyle}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => finish(true)}
    />
  );
}

function NoteNodeImpl({ id, data }) {
  const { updateNodeData } = useReactFlow();
  const [editing, setEditing] = useState(false);
  return (
    <NodeShell border={data.border} style={noteStyle}>
      <div style={foldStyle} />
      {editing ? (
        <NoteEditor
          initial={data.text}
          onCommit={(next) => {
            setEditing(false);
            updateNodeData(id, { text: next });
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div style={{ cursor: "text", ...(data.text ? null : ghostStyle) }} onClick={() => setEditing(true)}>
          {data.text || "note…"}
        </div>
      )}
    </NodeShell>
  );
}

export const NoteNode = memo(NoteNodeImpl);
