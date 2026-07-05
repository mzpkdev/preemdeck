// EnumNode.jsx — the «enumeration» box: a class-panel silhouette with the
// top-right corner cut (clip-path), a fixed «enumeration» tag, and one
// compartment of ordinal-indexed values. Ordinals derive from array index at
// render — they are never authored, so removing a value renumbers for free.
// Name and every value are inline-editable; `+ value` appends and opens the
// editor, the hover "×" removes. Everything commits via updateNodeData.
import { useReactFlow } from "@xyflow/react";
import { memo, useState } from "react";
import { AddRow, EditableText, MONO, RemoveX, editInputStyle, nameInputStyle } from "./parts/editing";
import { NodeShell } from "./parts/NodeShell";

const boxStyle = {
  minWidth: 150,
  maxWidth: 280,
  overflowWrap: "anywhere",
  clipPath: "polygon(0 0, calc(100% - 15px) 0, 100% 15px, 100% 100%, 0 100%)",
};

const headerStyle = { padding: "6px 10px", textAlign: "center" };
const guillemetStyle = { color: "var(--muted)", fontSize: 11 };
const compartmentStyle = { borderTop: "1px solid var(--border)", fontFamily: MONO };
const valueRowStyle = { display: "flex", alignItems: "baseline", padding: "4px 10px" };
const ordStyle = { display: "inline-block", width: 16, color: "var(--muted)", flex: "none" };
const valueStyle = { flex: 1, minWidth: 0, overflowWrap: "anywhere" };

function EnumNodeImpl({ id, data }) {
  const { updateNodeData } = useReactFlow();
  // Which slot is open: null | "name" | `value:${i}`.
  const [editing, setEditing] = useState(null);
  const values = data.values ?? [];

  const cancel = () => setEditing(null);
  const commitName = (next) => {
    setEditing(null);
    updateNodeData(id, { name: next });
  };
  const commitValue = (idx, next) => {
    setEditing(null);
    updateNodeData(id, { values: values.map((v, i) => (i === idx ? next : v)) });
  };
  const removeValue = (idx) => {
    setEditing(null);
    updateNodeData(id, { values: values.filter((_, i) => i !== idx) });
  };
  const addValue = () => {
    updateNodeData(id, { values: [...values, "VALUE"] });
    setEditing(`value:${values.length}`);
  };

  return (
    <NodeShell border={data.border} style={boxStyle}>
      <div style={headerStyle}>
        <div style={guillemetStyle}>«enumeration»</div>
        <div style={{ fontWeight: 700 }}>
          <EditableText
            editing={editing === "name"}
            value={data.name}
            onEdit={() => setEditing("name")}
            onCommit={commitName}
            onCancel={cancel}
            inputStyle={nameInputStyle}
          />
        </div>
      </div>

      <div style={compartmentStyle}>
        {values.map((value, i) => (
          <ValueRow
            key={i}
            ordinal={i}
            value={value}
            editing={editing === `value:${i}`}
            onEdit={() => setEditing(`value:${i}`)}
            onCommit={(next) => commitValue(i, next)}
            onRemove={() => removeValue(i)}
            onCancel={cancel}
          />
        ))}
        <AddRow label="+ value" onAdd={addValue} />
      </div>
    </NodeShell>
  );
}

function ValueRow({ ordinal, value, editing, onEdit, onCommit, onRemove, onCancel }) {
  const [hover, setHover] = useState(false);
  return (
    <div style={valueRowStyle} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <span style={ordStyle}>{ordinal}</span>
      <span style={valueStyle}>
        <EditableText
          editing={editing}
          value={value}
          onEdit={onEdit}
          onCommit={onCommit}
          onCancel={onCancel}
          inputStyle={editInputStyle}
        />
      </span>
      <RemoveX emphasized={hover} title="remove value" onRemove={onRemove} />
    </div>
  );
}

export const EnumNode = memo(EnumNodeImpl);
