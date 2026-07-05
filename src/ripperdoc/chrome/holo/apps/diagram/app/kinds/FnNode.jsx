// FnNode.jsx — the function/hook pill: a rounded capsule with the muted ƒ
// badge and the full signature as one editable monospace token (`name` holds
// it whole — `createShape(kind): Shape`).
import { useReactFlow } from "@xyflow/react";
import { memo, useState } from "react";
import { EditableText, MONO, editInputStyle } from "./parts/editing";
import { NodeShell } from "./parts/NodeShell";

const pillStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 16px",
  borderRadius: 999,
  fontFamily: MONO,
  whiteSpace: "nowrap",
};

const badgeStyle = { color: "var(--muted)", fontWeight: 700 };

function FnNodeImpl({ id, data }) {
  const { updateNodeData } = useReactFlow();
  const [editing, setEditing] = useState(false);
  return (
    <NodeShell border={data.border} style={pillStyle}>
      <span style={badgeStyle}>ƒ</span>
      <EditableText
        editing={editing}
        value={data.name}
        onEdit={() => setEditing(true)}
        onCommit={(next) => {
          setEditing(false);
          updateNodeData(id, { name: next });
        }}
        onCancel={() => setEditing(false)}
        inputStyle={editInputStyle}
      />
    </NodeShell>
  );
}

export const FnNode = memo(FnNodeImpl);
