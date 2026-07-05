// NodeShell.jsx — the shared node chrome every kind composes.
//
// One wrapper owns what must behave identically across all kinds: the panel
// look (--code-bg on a --border line), the `border: "distinct"` purple
// variant (applied LAST so it wins over a kind's own border colour while the
// kind keeps its border STYLE — a distinct external stays dashed), and the
// four side anchors. The anchors are hover-revealed dots (canvas-theme.css)
// that exist ONLY to start and land connection drags: edges never render from
// them (HoloEdge computes floating anchors from node geometry) and
// applyConnect strips their handle ids, so the spec stays node-level. Each
// side stacks a visible source handle (Loose connection mode makes it serve
// both drag directions) and an invisible, non-interactive target handle so
// React Flow can always resolve both ends of a handle-less edge.
import { Handle, Position } from "@xyflow/react";
import { Fragment } from "react";

/** The default panel look; kinds override via `style` (a pill radius, a teal border, …). */
export const boxChrome = {
  position: "relative",
  background: "var(--code-bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--fg)",
  fontSize: 12,
};

const distinctChrome = { borderWidth: 1.5, borderColor: "var(--distinct, #b08cdb)" };

const anchorStyle = { background: "var(--muted)", border: "none", width: 6, height: 6 };
const attachStyle = { ...anchorStyle, opacity: 0, pointerEvents: "none" };

const SIDES = [
  ["top", Position.Top],
  ["right", Position.Right],
  ["bottom", Position.Bottom],
  ["left", Position.Left],
];

/** The four side anchors, for kinds that lay their own chrome (cylinder, actor) but still connect. */
export function SideAnchors() {
  return SIDES.map(([side, position]) => (
    <Fragment key={side}>
      <Handle id={`a-${side}`} type="source" position={position} className="holo-anchor" style={anchorStyle} />
      <Handle id={`t-${side}`} type="target" position={position} style={attachStyle} isConnectable={false} />
    </Fragment>
  ));
}

export function NodeShell({ border, style, children }) {
  return (
    <div style={{ ...boxChrome, ...style, ...(border === "distinct" ? distinctChrome : null) }}>
      <SideAnchors />
      {children}
    </div>
  );
}
