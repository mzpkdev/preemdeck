// HoloEdge.jsx — the one custom edge component every edge renders through.
//
// Registered as edgeTypes={{ holo: HoloEdge }}; each edge carries its `kind`
// and `label` in `data` (see spec-sync.ts), and this component looks the kind
// up in the edge registry (visuals.ts) for line treatment + markers. Colours
// resolve through CSS vars so the theme owns them; the stroke is applied
// inline but swaps to the selection colour when selected, so selecting an edge
// stays visible over the kind colour.
//
// The label renders as an HTML div via EdgeLabelRenderer — mono 10px,
// colour-matched to the line, background --bg so it knocks the line out
// underneath (the catalog's `eltag`). Selecting the edge swaps the label spot
// for the editing chip: `[kind — click cycles] [label — click edits] [×]`,
// the same grammar as ClassNode's visibility glyph. Chip mutations go through
// updateEdgeData/deleteElements, so they land in React Flow state and flow out
// through the canvas's one emission path.
//
// Rendering is FLOATING: node-level ends ignore handle coordinates and anchor
// at the border point facing the counterpart (edges/anchors.ts), with a
// perpendicular offset separating parallel edges between the same pair. Only
// pin-anchored ends (an `out:`/`in:` handle on an io node) keep the
// handle-derived coordinates. Falls back to React Flow's handle positions
// until both nodes are measured.
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useEdges, useInternalNode, useReactFlow } from "@xyflow/react";
import { memo, useState } from "react";
import { CycleGlyph, EditableText, RemoveX, editInputStyle } from "../kinds/parts/editing";
import { floatingAnchors, labelSlide, parallelShift, pinAnchor } from "./anchors";
import { nextKind } from "./edge-ops";
import { EDGE_COLOR_VARS, EDGE_VISUALS, markerUrl } from "./visuals";

/** The absolute rect of a measured internal node, or null before measurement. */
const rectOf = (internal) => {
  const position = internal?.internals?.positionAbsolute;
  const width = internal?.measured?.width;
  const height = internal?.measured?.height;
  return position && width && height ? { x: position.x, y: position.y, width, height } : null;
};

const MONO_10 = '10px ui-monospace, "JetBrains Mono", Menlo, monospace';

const labelStyle = {
  position: "absolute",
  font: MONO_10,
  // Translucent knockout: dims the line under the text for readability while
  // keeping the arrow visible through the chip.
  background: "color-mix(in srgb, var(--bg, #1e1f22) 72%, transparent)",
  padding: "0 4px",
  borderRadius: 3,
  pointerEvents: "none",
};

// The selected-edge chip: interactive, so it opts back into pointer events and
// carries the nodrag/nopan discipline like every node editor.
const chipStyle = {
  position: "absolute",
  display: "flex",
  alignItems: "baseline",
  gap: 6,
  font: MONO_10,
  color: "var(--fg, #bcbec3)",
  background: "var(--code-bg, #303235)",
  border: "1px solid var(--border, #4f5153)",
  borderRadius: 4,
  padding: "2px 6px",
  pointerEvents: "all",
};

const labelInputStyle = { ...editInputStyle, font: MONO_10 };

function HoloEdgeImpl({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  sourceHandleId,
  targetHandleId,
  data,
  selected,
}) {
  const { updateEdgeData, deleteElements } = useReactFlow();
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  const edges = useEdges();
  const [editingLabel, setEditingLabel] = useState(false);
  const kind = data?.kind ?? "association";
  const visual = EDGE_VISUALS[kind];
  const color = EDGE_COLOR_VARS[visual.color];

  // Floating ends: replace handle coordinates with facing-border anchors for
  // every end that is NOT pinned to an io port handle. A pinned end keeps the
  // handle's y (the pin row) but snaps x to whichever border faces the
  // counterpart (anchors.pinAnchor) — the catalog's out-pin behaviour.
  let ends = { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition };
  const shift = parallelShift(id, source, target, edges);
  const sourceRect = rectOf(sourceNode);
  const targetRect = rectOf(targetNode);
  if (sourceRect && targetRect) {
    const anchors = floatingAnchors(sourceRect, targetRect, shift);
    if (sourceHandleId?.startsWith("out:")) {
      const pinned = pinAnchor(sourceRect, sourceY, targetRect.x + targetRect.width / 2);
      ends = { ...ends, sourceX: pinned.x, sourceY: pinned.y, sourcePosition: pinned.side };
    } else {
      ends = { ...ends, sourceX: anchors.source.x, sourceY: anchors.source.y, sourcePosition: anchors.source.side };
    }
    if (targetHandleId?.startsWith("in:")) {
      const pinned = pinAnchor(targetRect, targetY, sourceRect.x + sourceRect.width / 2);
      ends = { ...ends, targetX: pinned.x, targetY: pinned.y, targetPosition: pinned.side };
    } else {
      ends = { ...ends, targetX: anchors.target.x, targetY: anchors.target.y, targetPosition: anchors.target.side };
    }
  }
  const [path, labelX, labelY] = getBezierPath(ends);
  // Parallel edges spread their labels diagonally (perpendicular shift + slide
  // along the line); a lone edge keeps the exact midpoint.
  const slide = labelSlide(
    shift,
    { x: ends.sourceX, y: ends.sourceY },
    { x: ends.targetX, y: ends.targetY },
  );
  const midpoint = `translate(-50%, -50%) translate(${labelX + slide.x}px, ${labelY + slide.y}px)`;
  // Committing an empty label clears it (undefined drops from the JSON on POST).
  const commitLabel = (next) => {
    setEditingLabel(false);
    updateEdgeData(id, { label: next.trim() === "" ? undefined : next });
  };
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerStart={visual.markerStart ? markerUrl(visual.markerStart) : undefined}
        markerEnd={visual.markerEnd ? markerUrl(visual.markerEnd) : undefined}
        style={{
          stroke: selected ? "var(--xy-edge-stroke-selected, #287bde)" : color,
          strokeWidth: visual.color === "line" ? 1.3 : 1.4,
          strokeDasharray: visual.dashed ? "5 4" : undefined,
        }}
      />
      {selected ? (
        <EdgeLabelRenderer>
          <div className="nodrag nopan" style={{ ...chipStyle, transform: midpoint }}>
            <CycleGlyph
              value={kind}
              color={color}
              title="cycle edge kind"
              onCycle={() => updateEdgeData(id, { kind: nextKind(kind) })}
            />
            <EditableText
              editing={editingLabel}
              value={data?.label ?? ""}
              display={data?.label || "label"}
              ghost={!data?.label}
              onEdit={() => setEditingLabel(true)}
              onCommit={commitLabel}
              onCancel={() => setEditingLabel(false)}
              inputStyle={labelInputStyle}
            />
            <RemoveX emphasized title="delete edge" onRemove={() => deleteElements({ edges: [{ id }] })} />
          </div>
        </EdgeLabelRenderer>
      ) : data?.label ? (
        <EdgeLabelRenderer>
          <div style={{ ...labelStyle, color, transform: midpoint }}>{data.label}</div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const HoloEdge = memo(HoloEdgeImpl);
