// ClassNode.jsx — a React Flow custom node rendering a UML class box.
//
// `data` is a parsed ClassNodeSpec (see ./schema). The box keeps the classic
// three-compartment UML shape: a centered header (optional «stereotype» line +
// name), an attributes band, and a methods band — each band a border-topped
// compartment that renders even when empty so the shape is stable. Members are
// structured, so we lay out `‹vis› name: type` / `‹vis› name(params): type`
// ourselves and colour the visibility glyph. The stereotype is free-form and
// always renders in guillemets; `abstract`/`interface` additionally italicise
// the name. Chrome, the distinct-border variant, and the side anchors all come
// from parts/NodeShell.jsx; theming rides the host palette vars plus the
// diagram tokens in theme/tokens.css (--pub/--priv/--prot/--pkg glyphs).
//
// The class name, every member NAME, each method's (params), and every member's
// return `type` (free-form) are inline-editable, and members are add/remove-able —
// all through the shared primitives in parts/editing.jsx (one-shot <Editor>,
// EditableText, CycleGlyph, AddRow, RemoveX), which own the nodrag/nopan and
// stop-propagation discipline. Clicking the visibility glyph cycles +/-/#/~
// (public/private/protected/package). All edits write back through
// useReactFlow().updateNodeData(id, ...); entry.jsx watches node data and debounces a
// POST to persist the graph file. A typeless member shows a muted `:` to add a type.
import { useReactFlow } from "@xyflow/react";
import { memo, useState } from "react";
import { AddRow, CycleGlyph, EditableText, MONO, RemoveX, editInputStyle, nameInputStyle } from "./parts/editing";
import { NodeShell } from "./parts/NodeShell";

/** Visibility glyph → colour, riding the diagram tokens (theme/tokens.css). */
const VIS_COLORS = {
  "+": "var(--pub)", // public
  "-": "var(--priv)", // private
  "#": "var(--prot)", // protected
  "~": "var(--pkg)", // package
};

/** Click-to-cycle order for the visibility glyph: public → private → protected → package. */
const VIS_CYCLE = ["+", "-", "#", "~"];
const nextVis = (v) => VIS_CYCLE[(VIS_CYCLE.indexOf(v) + 1) % VIS_CYCLE.length];

// NodeShell owns the panel chrome; this sizes the box and wraps long signatures.
const boxStyle = {
  minWidth: 150,
  maxWidth: 280,
  overflowWrap: "anywhere",
};

const headerStyle = { padding: "6px 10px", textAlign: "center" };
const guillemetStyle = { color: "var(--muted)", fontSize: 11 };

const compartmentStyle = { borderTop: "1px solid var(--border)", fontFamily: MONO };
// A member row: content on the left, a hover-revealed remove "×" on the right.
const memberRowStyle = { display: "flex", alignItems: "baseline", gap: 6, padding: "4px 10px" };
const memberContentStyle = { flex: 1, minWidth: 0, overflowWrap: "anywhere" };

/**
 * One attribute/method row: a click-to-cycle visibility glyph, the editable name
 * token, an optional editable `(params)` token (methods only — attributes pass
 * `params === undefined`), the editable type suffix (`: type`), and a hover "×"
 * that removes the row. Name, params, and type each open an inline <input> on
 * click.
 */
function MemberRow({
  vis,
  name,
  params,
  type,
  nameEditing,
  paramsEditing,
  typeEditing,
  onEditName,
  onEditParams,
  onEditType,
  onCommitName,
  onCommitParams,
  onCommitType,
  onCycleVis,
  onRemove,
  onCancel,
}) {
  const hasParams = params !== undefined;
  const [hover, setHover] = useState(false);
  return (
    <div style={memberRowStyle} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <span style={memberContentStyle}>
        <CycleGlyph
          value={vis}
          color={VIS_COLORS[vis]}
          title="cycle visibility (public / private / protected / package)"
          onCycle={onCycleVis}
        />{" "}
        <EditableText
          editing={nameEditing}
          value={name}
          onEdit={onEditName}
          onCommit={onCommitName}
          onCancel={onCancel}
          inputStyle={editInputStyle}
        />
        {hasParams ? (
          <EditableText
            editing={paramsEditing}
            value={params}
            display={`(${params})`}
            prefix="("
            suffix=")"
            onEdit={onEditParams}
            onCommit={onCommitParams}
            onCancel={onCancel}
            inputStyle={editInputStyle}
          />
        ) : null}
        <EditableText
          editing={typeEditing}
          value={type ?? ""}
          display={type ? `: ${type}` : " :"}
          ghost={!type}
          prefix=": "
          onEdit={onEditType}
          onCommit={onCommitType}
          onCancel={onCancel}
          inputStyle={editInputStyle}
        />
      </span>
      <RemoveX emphasized={hover} title="remove member" onRemove={onRemove} />
    </div>
  );
}

function ClassNodeImpl({ id, data }) {
  const { updateNodeData } = useReactFlow();
  // Which slot is open: null | "name" | `attr:${i}` | `atype:${i}` | `method:${i}` |
  // `mparams:${i}` | `mtype:${i}` (name/params/type tokens per member).
  const [editing, setEditing] = useState(null);

  // UML abstract convention: abstract + interface names render italic.
  const italic = data.stereotype === "abstract" || data.stereotype === "interface";
  // Any stereotype gets the guillemet header line («abstract» included).
  const guillemet = data.stereotype ? `«${data.stereotype}»` : null;
  const attributes = data.attributes ?? [];
  const methods = data.methods ?? [];

  const cancel = () => setEditing(null);
  const commitName = (next) => {
    setEditing(null);
    updateNodeData(id, { name: next });
  };
  const commitAttr = (idx, next) => {
    setEditing(null);
    updateNodeData(id, { attributes: attributes.map((a, i) => (i === idx ? { ...a, name: next } : a)) });
  };
  const commitMethod = (idx, next) => {
    setEditing(null);
    updateNodeData(id, { methods: methods.map((m, i) => (i === idx ? { ...m, name: next } : m)) });
  };
  const commitMethodParams = (idx, next) => {
    setEditing(null);
    updateNodeData(id, { methods: methods.map((m, i) => (i === idx ? { ...m, params: next } : m)) });
  };
  // Free-form type; committing empty clears it (undefined drops from the JSON on POST).
  const commitAttrType = (idx, next) => {
    setEditing(null);
    const type = next.trim() === "" ? undefined : next;
    updateNodeData(id, { attributes: attributes.map((a, i) => (i === idx ? { ...a, type } : a)) });
  };
  const commitMethodType = (idx, next) => {
    setEditing(null);
    const type = next.trim() === "" ? undefined : next;
    updateNodeData(id, { methods: methods.map((m, i) => (i === idx ? { ...m, type } : m)) });
  };
  // Click the glyph to cycle visibility (public/private/protected/package).
  const cycleAttrVis = (idx) => {
    updateNodeData(id, { attributes: attributes.map((a, i) => (i === idx ? { ...a, vis: nextVis(a.vis) } : a)) });
  };
  const cycleMethodVis = (idx) => {
    updateNodeData(id, { methods: methods.map((m, i) => (i === idx ? { ...m, vis: nextVis(m.vis) } : m)) });
  };
  const removeAttr = (idx) => {
    setEditing(null);
    updateNodeData(id, { attributes: attributes.filter((_, i) => i !== idx) });
  };
  const removeMethod = (idx) => {
    setEditing(null);
    updateNodeData(id, { methods: methods.filter((_, i) => i !== idx) });
  };
  // Append a default PUBLIC member and open its name editor at the new last index.
  const addAttr = () => {
    updateNodeData(id, { attributes: [...attributes, { vis: "+", name: "field" }] });
    setEditing(`attr:${attributes.length}`);
  };
  const addMethod = () => {
    updateNodeData(id, { methods: [...methods, { vis: "+", name: "method", params: "" }] });
    setEditing(`method:${methods.length}`);
  };

  return (
    <NodeShell border={data.border} style={boxStyle}>
      <div style={headerStyle}>
        {guillemet ? <div style={guillemetStyle}>{guillemet}</div> : null}
        <div style={{ fontWeight: 700, fontStyle: italic ? "italic" : "normal" }}>
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
        {attributes.map((a, i) => (
          <MemberRow
            key={i}
            vis={a.vis}
            name={a.name}
            type={a.type}
            nameEditing={editing === `attr:${i}`}
            typeEditing={editing === `atype:${i}`}
            onEditName={() => setEditing(`attr:${i}`)}
            onEditType={() => setEditing(`atype:${i}`)}
            onCommitName={(next) => commitAttr(i, next)}
            onCommitType={(next) => commitAttrType(i, next)}
            onCycleVis={() => cycleAttrVis(i)}
            onRemove={() => removeAttr(i)}
            onCancel={cancel}
          />
        ))}
        <AddRow label="+ attribute" onAdd={addAttr} />
      </div>

      <div style={compartmentStyle}>
        {methods.map((m, i) => (
          <MemberRow
            key={i}
            vis={m.vis}
            name={m.name}
            params={m.params ?? ""}
            type={m.type}
            nameEditing={editing === `method:${i}`}
            paramsEditing={editing === `mparams:${i}`}
            typeEditing={editing === `mtype:${i}`}
            onEditName={() => setEditing(`method:${i}`)}
            onEditParams={() => setEditing(`mparams:${i}`)}
            onEditType={() => setEditing(`mtype:${i}`)}
            onCommitName={(next) => commitMethod(i, next)}
            onCommitParams={(next) => commitMethodParams(i, next)}
            onCommitType={(next) => commitMethodType(i, next)}
            onCycleVis={() => cycleMethodVis(i)}
            onRemove={() => removeMethod(i)}
            onCancel={cancel}
          />
        ))}
        <AddRow label="+ method" onAdd={addMethod} />
      </div>
    </NodeShell>
  );
}

export const ClassNode = memo(ClassNodeImpl);
