// ClassNode.jsx — a React Flow custom node rendering a UML class box.
//
// `data` is a parsed ClassNodeSpec (see ./schema). The box keeps the classic
// three-compartment UML shape: a centered header (optional «stereotype» line +
// name), an attributes band, and a methods band — each band a border-topped
// compartment that renders even when empty so the shape is stable. Members are
// structured, so we lay out `‹vis› name: type` / `‹vis› name(params): type`
// ourselves and colour the visibility glyph. Theming rides the palette vars from
// style.css (--code-bg/--fg/--border/--muted); the only hardcoded colours are the
// visibility glyph palette, which has no theme var. Two handles (target top,
// source bottom) let edges attach under the top-down ELK layout.
//
// The class name, every member NAME, each method's (params), and every member's
// return `type` (free-form) are inline-editable: click a token to open a controlled
// <input>, Enter or blur commits, Escape reverts. Members are add/remove-able too:
// the muted "+ attribute"/"+ method" row appends one (opening its name editor), the
// hover "×" removes it, and clicking the visibility glyph cycles +/-/#/~
// (public/private/protected/package). All edits write back through
// useReactFlow().updateNodeData(id, ...); entry.jsx watches node data and debounces a
// POST to persist the graph file. A typeless member shows a muted `:` to add a type.
import { Handle, Position, useReactFlow } from "@xyflow/react";
import { memo, useEffect, useRef, useState } from "react";

/** Visibility glyph → colour. No palette var exists for these, so they're literal. */
const VIS_COLORS = {
  "+": "#6aab73", // public
  "-": "#e5534b", // private
  "#": "#cf8e6d", // protected
  "~": "var(--muted)", // package
};

/** Click-to-cycle order for the visibility glyph: public → private → protected → package. */
const VIS_CYCLE = ["+", "-", "#", "~"];
const nextVis = (v) => VIS_CYCLE[(VIS_CYCLE.indexOf(v) + 1) % VIS_CYCLE.length];

const MONO = 'ui-monospace, "JetBrains Mono", Menlo, monospace';

const boxStyle = {
  background: "var(--code-bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--fg)",
  minWidth: 150,
  maxWidth: 280,
  fontSize: 12,
  overflowWrap: "anywhere", // long signatures wrap instead of blowing out maxWidth
};

const headerStyle = { padding: "6px 10px", textAlign: "center" };
const guillemetStyle = { color: "var(--muted)", fontSize: 11 };

const compartmentStyle = { borderTop: "1px solid var(--border)", fontFamily: MONO };
// A member row: content on the left, a hover-revealed remove "×" on the right.
const memberRowStyle = { display: "flex", alignItems: "baseline", gap: 6, padding: "4px 10px" };
const memberContentStyle = { flex: 1, minWidth: 0, overflowWrap: "anywhere" };
const removeBtnStyle = {
  flex: "none",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  font: "inherit",
  lineHeight: 1,
  padding: 0,
};
// The muted "+ member" affordance at the foot of each compartment.
const addRowStyle = {
  padding: "3px 10px",
  color: "var(--muted)",
  cursor: "pointer",
  fontStyle: "italic",
  fontSize: 11,
};
// The visibility glyph is clickable — it cycles +/-/#/~.
const visStyle = { cursor: "pointer" };

const handleStyle = { background: "var(--muted)", border: "none", width: 6, height: 6 };

// Shared chrome for the inline editors: transparent so the box colour shows
// through, font inherited from the slot it replaces (bold sans for the class
// name, monospace for members), width tracks content via the `size` attribute.
const editInputStyle = {
  font: "inherit",
  color: "var(--fg)",
  background: "transparent",
  border: "none",
  borderRadius: 3,
  padding: 0,
  margin: 0,
  outline: "none",
  height: "1em",
  fieldSizing: "content",
  boxSizing: "border-box",
};
const nameInputStyle = { ...editInputStyle, textAlign: "center" };
// Hint that the static name/member tokens open an editor on click.
const editableStyle = { cursor: "text" };

/** The «stereotype» guillemet line — only interface/enumeration get one. */
const guillemetFor = (stereotype) =>
  stereotype === "interface" ? "«interface»" : stereotype === "enumeration" ? "«enumeration»" : null;

/**
 * A one-shot inline text editor. Mounts already focused with its text selected;
 * commits on Enter or blur, reverts on Escape. `done` guards the Enter→blur
 * double fire (committing on Enter unmounts the input, which also blurs it). The
 * input is marked nodrag/nopan and stops every pointer/key event so React Flow
 * doesn't pan, drag, or Backspace-delete the node while you type.
 */
function Editor({ initial, onCommit, onCancel, style }) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef(null);
  const done = useRef(false);
  // Focus + select ONCE on mount. An inline ref callback re-runs every render (new
  // identity), re-selecting the text after each keystroke so the next key overwrites
  // it — that was the single-letter bug.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const finish = (commit) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };
  return (
    <input
      className="nodrag nopan"
      ref={inputRef}
      value={value}
      size={Math.max(value.length + 1, 3)}
      style={style}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => finish(true)}
    />
  );
}

/**
 * One attribute/method row: a click-to-cycle visibility glyph, the editable name
 * token, an optional editable `(params)` token (methods only — attributes pass
 * `params === undefined`), the editable type suffix (`: type`), and a hover "×"
 * that removes the row. Name, params, and type each open an inline <input> on
 * click. The glyph, the × and the row's own add affordance carry nodrag/nopan and
 * stop propagation so React Flow doesn't drag/select the node instead of acting.
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
        <span
          className="nodrag nopan"
          style={{ ...visStyle, color: VIS_COLORS[vis] }}
          title="cycle visibility (public / private / protected / package)"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onCycleVis();
          }}
        >
          {vis}
        </span>{" "}
        {nameEditing ? (
          <Editor initial={name} onCommit={onCommitName} onCancel={onCancel} style={editInputStyle} />
        ) : (
          <span style={editableStyle} onClick={onEditName}>
            {name}
          </span>
        )}
        {hasParams ? (
          paramsEditing ? (
            <>
              {"("}
              <Editor initial={params} onCommit={onCommitParams} onCancel={onCancel} style={editInputStyle} />
              {")"}
            </>
          ) : (
            <span style={editableStyle} onClick={onEditParams}>
              {`(${params})`}
            </span>
          )
        ) : null}
        {typeEditing ? (
          <>
            {": "}
            <Editor initial={type ?? ""} onCommit={onCommitType} onCancel={onCancel} style={editInputStyle} />
          </>
        ) : type ? (
          <span style={editableStyle} onClick={onEditType}>
            {`: ${type}`}
          </span>
        ) : (
          <span style={{ ...editableStyle, color: "var(--muted)" }} onClick={onEditType}>
            {" :"}
          </span>
        )}
      </span>
      <button
        type="button"
        className="nodrag nopan"
        style={{ ...removeBtnStyle, color: hover ? "#e5534b" : "var(--muted)", opacity: hover ? 1 : 0.35 }}
        title="remove member"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
      >
        ×
      </button>
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
  const guillemet = guillemetFor(data.stereotype);
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
    <div style={boxStyle}>
      <Handle type="target" position={Position.Top} style={handleStyle} />

      <div style={headerStyle}>
        {guillemet ? <div style={guillemetStyle}>{guillemet}</div> : null}
        <div style={{ fontWeight: 700, fontStyle: italic ? "italic" : "normal" }}>
          {editing === "name" ? (
            <Editor initial={data.name} onCommit={commitName} onCancel={cancel} style={nameInputStyle} />
          ) : (
            <span style={editableStyle} onClick={() => setEditing("name")}>
              {data.name}
            </span>
          )}
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
        <div
          className="nodrag nopan"
          style={addRowStyle}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            addAttr();
          }}
        >
          + attribute
        </div>
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
        <div
          className="nodrag nopan"
          style={addRowStyle}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            addMethod();
          }}
        >
          + method
        </div>
      </div>

      <Handle type="source" position={Position.Bottom} style={handleStyle} />
    </div>
  );
}

export const ClassNode = memo(ClassNodeImpl);
