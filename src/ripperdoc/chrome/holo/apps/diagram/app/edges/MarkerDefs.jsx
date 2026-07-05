// MarkerDefs.jsx — the shared SVG marker vocabulary, mounted once per canvas.
//
// A zero-size <svg><defs> rendered as a child of <ReactFlow>, so the markers
// live INSIDE .react-flow — that placement is load-bearing: CSS custom
// properties resolve where a marker is DEFINED, and the marker paths take
// their fills/strokes from classes styled off the tokens in theme/tokens.css
// (see canvas-theme.css), fixing the catalog mockup's hardcoded-hex flaw.
//
// Geometry is lifted from the mockup's hand-tuned defs
// (experiments/uml-nodes-and-edges-catalog.html): userSpaceOnUse keeps marker
// size independent of stroke width; refX anchors the tip (end markers) or the
// near vertex (start diamonds) exactly on the node border. The hollow triangle
// only ever renders at the START end (source = parent), so it carries
// `auto-start-reverse` to point INTO the parent; diamonds keep plain `auto` —
// at a path start that lays the rhombus along the outgoing edge with its near
// tip touching the owner, exactly the catalog's marker-start behaviour.
//
// When a plan embeds several diagrams, each canvas mounts its own copy of
// these ids; url(#…) resolves the first in document order and the copies are
// identical, so the duplication is harmless.
export function MarkerDefs() {
  return (
    <svg style={{ position: "absolute", width: 0, height: 0 }} aria-hidden="true">
      <defs>
        <marker
          id="holo-mk-tri"
          markerUnits="userSpaceOnUse"
          markerWidth="16"
          markerHeight="14"
          refX="14"
          refY="7"
          orient="auto-start-reverse"
        >
          <path className="holo-mk-hollow" d="M2,1 L15,7 L2,13 Z" />
        </marker>
        <marker
          id="holo-mk-open"
          markerUnits="userSpaceOnUse"
          markerWidth="14"
          markerHeight="12"
          refX="10"
          refY="6"
          orient="auto"
        >
          <path className="holo-mk-open" d="M2,2 L10,6 L2,10" />
        </marker>
        <marker
          id="holo-mk-dia-hollow"
          markerUnits="userSpaceOnUse"
          markerWidth="20"
          markerHeight="12"
          refX="2"
          refY="6"
          orient="auto"
        >
          <path className="holo-mk-hollow" d="M2,6 L9,2 L16,6 L9,10 Z" />
        </marker>
        <marker
          id="holo-mk-dia-filled"
          markerUnits="userSpaceOnUse"
          markerWidth="20"
          markerHeight="12"
          refX="2"
          refY="6"
          orient="auto"
        >
          <path className="holo-mk-filled" d="M2,6 L9,2 L16,6 L9,10 Z" />
        </marker>
        <marker
          id="holo-mk-arr-sync"
          markerUnits="userSpaceOnUse"
          markerWidth="11"
          markerHeight="11"
          refX="8"
          refY="5.5"
          orient="auto"
        >
          <path className="holo-mk-sync" d="M1,1 L9,5.5 L1,10 Z" />
        </marker>
        <marker
          id="holo-mk-arr-async"
          markerUnits="userSpaceOnUse"
          markerWidth="11"
          markerHeight="11"
          refX="8"
          refY="5.5"
          orient="auto"
        >
          <path className="holo-mk-async" d="M1,1 L9,5.5 L1,10 Z" />
        </marker>
      </defs>
    </svg>
  );
}
