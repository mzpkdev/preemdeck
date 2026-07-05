// ChannelNode.jsx — the async conduit (queue / topic / stream / bus): a
// teal-accented capsule with the uppercase transport label, the monospace
// channel name, and the right-edge stripe. Transport and name are editable;
// an empty transport commit clears the field and the render falls back to
// "topic". The stripe+content sit in an inner clipped wrapper so the shell's
// side anchors stay outside the clip.
import { useReactFlow } from "@xyflow/react";
import { memo, useState } from "react";
import { EditableText, MONO, editInputStyle } from "./parts/editing";
import { NodeShell } from "./parts/NodeShell";

const channelStyle = {
  display: "flex",
  width: 180,
  height: 42,
  border: "1.5px solid var(--async, #4db6ac)",
  borderRadius: 8,
};

const clipStyle = { display: "flex", alignItems: "center", flex: 1, overflow: "hidden", borderRadius: 7 };
const bodyStyle = { display: "flex", alignItems: "center", gap: 8, padding: "0 12px", flex: 1 };
const transportStyle = {
  color: "var(--async, #4db6ac)",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
};
const nameStyle = { fontFamily: MONO, fontSize: 12 };
const slotsStyle = { display: "flex", alignSelf: "stretch" };
const slotStyle = { width: 12, borderLeft: "1px solid var(--border)" };

function ChannelNodeImpl({ id, data }) {
  const { updateNodeData } = useReactFlow();
  // Which slot is open: null | "transport" | "name".
  const [editing, setEditing] = useState(null);
  const cancel = () => setEditing(null);
  return (
    <NodeShell border={data.border} style={channelStyle}>
      <div style={clipStyle}>
        <div style={bodyStyle}>
          <span style={transportStyle}>
            <EditableText
              editing={editing === "transport"}
              value={data.transport ?? ""}
              display={data.transport ?? "topic"}
              ghost={!data.transport}
              onEdit={() => setEditing("transport")}
              onCommit={(next) => {
                cancel();
                updateNodeData(id, { transport: next.trim() === "" ? undefined : next });
              }}
              onCancel={cancel}
              inputStyle={editInputStyle}
            />
          </span>
          <span style={nameStyle}>
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
          </span>
        </div>
        <div style={slotsStyle}>
          <i style={slotStyle} />
        </div>
      </div>
    </NodeShell>
  );
}

export const ChannelNode = memo(ChannelNodeImpl);
