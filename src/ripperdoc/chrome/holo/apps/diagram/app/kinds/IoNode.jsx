// IoNode.jsx — the component/service box with typed ports: a header
// («stereotype» tag + name) over an in-pins band and an out-pins band. Each
// pin is a direction dot (blue in / orange out), an editable label, a
// click-to-cycle binding tag (· → http → grpc → event → ·), and a hover "×".
// `+ in` / `+ out` append a pin (with a generated stable id) and open its
// label editor.
//
// Pins that carry an `id` render REAL React Flow handles — in-pins a target
// handle on the row's left border, out-pins a source handle on the right —
// and edges anchored there persist `sourcePort`/`targetPort` (spec-sync.ts).
// Adding/removing pins changes the node's handle set, so an effect keyed on
// the pin-id signature calls updateNodeInternals, or edges would keep
// anchoring at stale offsets.
import { Handle, Position, useReactFlow, useUpdateNodeInternals } from "@xyflow/react";
import { memo, useEffect, useState } from "react";
import { AddRow, CycleGlyph, EditableText, MONO, RemoveX, editInputStyle, nameInputStyle } from "./parts/editing";
import { NodeShell } from "./parts/NodeShell";

const boxStyle = { width: 190 };

const headStyle = { padding: "6px 10px", textAlign: "center", borderBottom: "1px solid var(--border)" };
const guillemetStyle = { color: "var(--muted)", fontSize: 11 };
const pinsStyle = { padding: "3px 0" };
const pinsOutStyle = { ...pinsStyle, borderTop: "1px solid var(--border)" };
const pinRowStyle = {
  position: "relative", // pin handles anchor to the row, at the node borders
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 10px",
  fontFamily: MONO,
  fontSize: 11,
};
const dotStyle = (dir) => ({
  width: 7,
  height: 7,
  borderRadius: "50%",
  flex: "none",
  background: dir === "in" ? "var(--in, #287bde)" : "var(--out, #cf8e6d)",
});
const pinHandleStyle = (dir) => ({
  width: 6,
  height: 6,
  border: "none",
  background: dir === "in" ? "var(--in, #287bde)" : "var(--out, #cf8e6d)",
});
const bindingStyle = { color: "var(--muted)", fontSize: 10, flex: "none" };

/** Binding cycle: none → http → grpc → event → none (a custom binding steps back into the cycle). */
const BINDINGS = ["http", "grpc", "event"];
const nextBinding = (binding) => (binding === undefined ? "http" : BINDINGS[BINDINGS.indexOf(binding) + 1]);

/** A deterministic pin id no existing pin uses (`p0`, `p1`, …). */
const genPinId = (pins) => {
  const ids = new Set(pins.map((p) => p.id).filter(Boolean));
  let n = ids.size;
  while (ids.has(`p${n}`)) n++;
  return `p${n}`;
};

function PinRow({ dir, pin, editing, onEdit, onCommit, onCycleBinding, onRemove, onCancel }) {
  const [hover, setHover] = useState(false);
  return (
    <div style={pinRowStyle} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {pin.id ? (
        <Handle
          type={dir === "in" ? "target" : "source"}
          id={`${dir}:${pin.id}`}
          position={dir === "in" ? Position.Left : Position.Right}
          className="holo-anchor"
          style={pinHandleStyle(dir)}
        />
      ) : null}
      <span style={dotStyle(dir)} />
      <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
        <EditableText
          editing={editing}
          value={pin.label}
          onEdit={onEdit}
          onCommit={onCommit}
          onCancel={onCancel}
          inputStyle={editInputStyle}
        />
      </span>
      <CycleGlyph
        value={pin.binding ?? "·"}
        title="cycle binding (http / grpc / event / none)"
        onCycle={onCycleBinding}
        style={bindingStyle}
      />
      <RemoveX emphasized={hover} title="remove pin" onRemove={onRemove} />
    </div>
  );
}

function IoNodeImpl({ id, data }) {
  const { updateNodeData, setEdges } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  // Which slot is open: null | "name" | "stereo" | `inl:${i}` | `outl:${i}`.
  const [editing, setEditing] = useState(null);
  const inputs = data.inputs ?? [];
  const outputs = data.outputs ?? [];

  // Handles live per pin id — re-measure them whenever the id set shifts.
  const pinSignature = [...inputs, ...outputs].map((p) => p.id ?? "").join("|");
  useEffect(() => updateNodeInternals(id), [id, pinSignature, updateNodeInternals]);

  const cancel = () => setEditing(null);
  const commit = (patch) => {
    setEditing(null);
    updateNodeData(id, patch);
  };
  const patchPin = (key, pins, idx, patch) => ({ [key]: pins.map((p, i) => (i === idx ? { ...p, ...patch } : p)) });
  const addPin = (key, pins, editPrefix) => {
    updateNodeData(id, { [key]: [...pins, { id: genPinId([...inputs, ...outputs]), label: "pin" }] });
    setEditing(`${editPrefix}:${pins.length}`);
  };
  // Removing a pin also detaches any edge anchored to its port (the end drops
  // to node level) — otherwise the projected spec would name a gone pin id and
  // fail validation on the next load.
  const removePin = (key, pins, idx) => {
    const pin = pins[idx];
    commit({ [key]: pins.filter((_, x) => x !== idx) });
    if (!pin?.id) return;
    const sourceHandle = `out:${pin.id}`;
    const targetHandle = `in:${pin.id}`;
    setEdges((eds) =>
      eds.map((e) => {
        if (e.source === id && e.sourceHandle === sourceHandle) return { ...e, sourceHandle: null };
        if (e.target === id && e.targetHandle === targetHandle) return { ...e, targetHandle: null };
        return e;
      }),
    );
  };

  return (
    <NodeShell border={data.border} style={boxStyle}>
      <div style={headStyle}>
        <div style={guillemetStyle}>
          <EditableText
            editing={editing === "stereo"}
            value={data.stereotype ?? ""}
            display={`«${data.stereotype ?? "component"}»`}
            ghost={!data.stereotype}
            onEdit={() => setEditing("stereo")}
            onCommit={(next) => commit({ stereotype: next.trim() === "" ? undefined : next })}
            onCancel={cancel}
            inputStyle={{ ...editInputStyle, textAlign: "center" }}
          />
        </div>
        <div style={{ fontWeight: 700 }}>
          <EditableText
            editing={editing === "name"}
            value={data.name}
            onEdit={() => setEditing("name")}
            onCommit={(next) => commit({ name: next })}
            onCancel={cancel}
            inputStyle={nameInputStyle}
          />
        </div>
      </div>

      <div style={pinsStyle}>
        {inputs.map((pin, i) => (
          <PinRow
            key={pin.id ?? `i${i}`}
            dir="in"
            pin={pin}
            editing={editing === `inl:${i}`}
            onEdit={() => setEditing(`inl:${i}`)}
            onCommit={(next) => commit(patchPin("inputs", inputs, i, { label: next }))}
            onCycleBinding={() =>
              updateNodeData(id, patchPin("inputs", inputs, i, { binding: nextBinding(pin.binding) }))
            }
            onRemove={() => removePin("inputs", inputs, i)}
            onCancel={cancel}
          />
        ))}
        <AddRow label="+ in" onAdd={() => addPin("inputs", inputs, "inl")} />
      </div>

      <div style={pinsOutStyle}>
        {outputs.map((pin, i) => (
          <PinRow
            key={pin.id ?? `o${i}`}
            dir="out"
            pin={pin}
            editing={editing === `outl:${i}`}
            onEdit={() => setEditing(`outl:${i}`)}
            onCommit={(next) => commit(patchPin("outputs", outputs, i, { label: next }))}
            onCycleBinding={() =>
              updateNodeData(id, patchPin("outputs", outputs, i, { binding: nextBinding(pin.binding) }))
            }
            onRemove={() => removePin("outputs", outputs, i)}
            onCancel={cancel}
          />
        ))}
        <AddRow label="+ out" onAdd={() => addPin("outputs", outputs, "outl")} />
      </div>
    </NodeShell>
  );
}

export const IoNode = memo(IoNodeImpl);
