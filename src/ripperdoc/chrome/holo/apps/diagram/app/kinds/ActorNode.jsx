// ActorNode.jsx — the C4 person: a stick figure (inline SVG — the one node
// drawn as SVG in the catalog too), the fixed «actor» tag, and an editable
// name. Chromeless: the shell keeps its side anchors but drops the panel box.
import { useReactFlow } from "@xyflow/react";
import { memo, useState } from "react";
import { EditableText, editInputStyle } from "./parts/editing";
import { NodeShell } from "./parts/NodeShell";

const personStyle = {
  background: "transparent",
  border: "none",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 3,
  padding: 2,
};

const figureStyle = { stroke: "var(--muted)", strokeWidth: 1.8, strokeLinecap: "round", fill: "none" };
const tagStyle = { color: "var(--muted)", fontSize: 10 };
const nameStyle = { fontWeight: 700, fontSize: 12 };

function ActorNodeImpl({ id, data }) {
  const { updateNodeData } = useReactFlow();
  const [editing, setEditing] = useState(false);
  return (
    <NodeShell border={data.border} style={personStyle}>
      <svg width="46" height="58" viewBox="0 0 46 58" style={figureStyle} aria-hidden="true">
        <circle cx="23" cy="9" r="7.5" style={{ fill: "var(--bg)" }} />
        <line x1="23" y1="16.5" x2="23" y2="37" />
        <line x1="9" y1="25" x2="37" y2="25" />
        <line x1="23" y1="37" x2="11" y2="54" />
        <line x1="23" y1="37" x2="35" y2="54" />
      </svg>
      <div style={tagStyle}>«actor»</div>
      <div style={nameStyle}>
        <EditableText
          editing={editing}
          value={data.name}
          onEdit={() => setEditing(true)}
          onCommit={(next) => {
            setEditing(false);
            updateNodeData(id, { name: next });
          }}
          onCancel={() => setEditing(false)}
          inputStyle={{ ...editInputStyle, textAlign: "center" }}
        />
      </div>
    </NodeShell>
  );
}

export const ActorNode = memo(ActorNodeImpl);
