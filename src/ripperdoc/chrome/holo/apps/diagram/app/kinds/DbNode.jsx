// DbNode.jsx — the datastore cylinder: elliptical border-radius body plus an
// inner ellipse lid (a real element, since inline styles can't reach
// ::before). Name (mono, centred) and the engine subtitle are editable; an
// empty engine commit clears the field (undefined drops from the JSON).
import { useReactFlow } from "@xyflow/react";
import { memo, useState } from "react";
import { EditableText, MONO, editInputStyle } from "./parts/editing";
import { NodeShell } from "./parts/NodeShell";

const cylinderStyle = { width: 120, height: 66, borderRadius: "60px / 13px" };

const lidStyle = {
  position: "absolute",
  top: 2,
  left: 6,
  right: 6,
  height: 13,
  border: "1px solid var(--border)",
  borderRadius: "50%",
};

const nameStyle = {
  position: "absolute",
  left: 0,
  right: 0,
  top: 24,
  textAlign: "center",
  fontFamily: MONO,
  fontSize: 11,
};

const engineStyle = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 7,
  textAlign: "center",
  fontSize: 9,
  color: "var(--muted)",
};

function DbNodeImpl({ id, data }) {
  const { updateNodeData } = useReactFlow();
  // Which slot is open: null | "name" | "engine".
  const [editing, setEditing] = useState(null);
  const cancel = () => setEditing(null);
  return (
    <NodeShell border={data.border} style={cylinderStyle}>
      <div style={lidStyle} />
      <div style={nameStyle}>
        <EditableText
          editing={editing === "name"}
          value={data.name}
          onEdit={() => setEditing("name")}
          onCommit={(next) => {
            cancel();
            updateNodeData(id, { name: next });
          }}
          onCancel={cancel}
          inputStyle={{ ...editInputStyle, textAlign: "center" }}
        />
      </div>
      <div style={engineStyle}>
        <EditableText
          editing={editing === "engine"}
          value={data.engine ?? ""}
          display={data.engine ?? "engine"}
          ghost={!data.engine}
          onEdit={() => setEditing("engine")}
          onCommit={(next) => {
            cancel();
            updateNodeData(id, { engine: next.trim() === "" ? undefined : next });
          }}
          onCancel={cancel}
          inputStyle={{ ...editInputStyle, textAlign: "center" }}
        />
      </div>
    </NodeShell>
  );
}

export const DbNode = memo(DbNodeImpl);
