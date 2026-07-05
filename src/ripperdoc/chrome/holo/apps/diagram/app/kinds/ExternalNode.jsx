// ExternalNode.jsx — a system you do not own: the dashed --muted box with the
// fixed «external» tag and an editable name. With `border: "distinct"` the
// dash stays and only width/colour go purple (NodeShell applies the variant
// last, style intact).
import { useReactFlow } from "@xyflow/react";
import { memo, useState } from "react";
import { EditableText, editInputStyle } from "./parts/editing";
import { NodeShell } from "./parts/NodeShell";

const externalStyle = {
  minWidth: 130,
  padding: "10px 14px",
  border: "1.5px dashed var(--muted)",
  textAlign: "center",
};

const tagStyle = { color: "var(--muted)", fontSize: 10 };
const nameStyle = { fontWeight: 700, fontSize: 12 };

function ExternalNodeImpl({ id, data }) {
  const { updateNodeData } = useReactFlow();
  const [editing, setEditing] = useState(false);
  return (
    <NodeShell border={data.border} style={externalStyle}>
      <div style={tagStyle}>«external»</div>
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

export const ExternalNode = memo(ExternalNodeImpl);
