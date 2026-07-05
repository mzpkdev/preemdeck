// GroupNode.jsx — the boundary frame: a dashed rounded rectangle sized by ELK
// from its children (applyElkPositions writes the computed width/height onto
// the React Flow node; the frame just fills it), with the label tab riding the
// top border — `«stereotype ?? boundary» name`, both editable. Groups render
// NO connection anchors: boundaries are containers, not endpoints (edge-ops
// rejects group connections too). Children are separate React Flow nodes with
// `parentId` pointing here; dragging the frame drags them along natively.
import { useReactFlow } from "@xyflow/react";
import { memo, useState } from "react";
import { EditableText, editInputStyle } from "./parts/editing";

const frameStyle = {
  width: "100%",
  height: "100%",
  border: "1.5px dashed var(--border)",
  borderRadius: 10,
  position: "relative",
  background: "transparent",
};

const distinctFrameStyle = { ...frameStyle, borderColor: "var(--distinct, #b08cdb)" };

const tabStyle = {
  position: "absolute",
  top: -9,
  left: 14,
  padding: "0 8px",
  background: "var(--bg, #1e1f22)",
  color: "var(--muted)",
  fontSize: 11,
  whiteSpace: "nowrap",
};

function GroupNodeImpl({ id, data }) {
  const { updateNodeData } = useReactFlow();
  // Which slot is open: null | "stereo" | "name".
  const [editing, setEditing] = useState(null);
  const cancel = () => setEditing(null);
  return (
    <div style={data.border === "distinct" ? distinctFrameStyle : frameStyle}>
      <div style={tabStyle}>
        <EditableText
          editing={editing === "stereo"}
          value={data.stereotype ?? ""}
          display={`«${data.stereotype ?? "boundary"}»`}
          ghost={!data.stereotype}
          onEdit={() => setEditing("stereo")}
          onCommit={(next) => {
            cancel();
            updateNodeData(id, { stereotype: next.trim() === "" ? undefined : next });
          }}
          onCancel={cancel}
          inputStyle={editInputStyle}
        />{" "}
        <EditableText
          editing={editing === "name"}
          value={data.name}
          onEdit={() => setEditing("name")}
          onCommit={(next) => {
            cancel();
            updateNodeData(id, { name: next });
          }}
          onCancel={cancel}
          inputStyle={editInputStyle}
        />
      </div>
    </div>
  );
}

export const GroupNode = memo(GroupNodeImpl);
