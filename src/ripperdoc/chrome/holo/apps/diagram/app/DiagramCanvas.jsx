// DiagramCanvas.jsx — the source-agnostic diagram renderer.
//
// Takes a parsed GraphSpec in (`{ nodes, edges }`) and emits the edited spec out
// via `onChange` — it knows nothing about WHERE the spec came from or where edits
// go. holo's standalone client (entry.jsx) fetches/POSTs the spec around it;
// planner reuses the same component against its own source. So this file has NO
// fetch, NO POST, NO debounce, NO JSON — pure spec-in / onChange-out.
//
// Layout is TWO-PASS + MEASURED (ELK does no text measurement, and UML boxes
// size to their content): pass 1 mounts every node hidden (opacity 0) at the
// origin so React Flow measures each rendered box; once `useNodesInitialized`
// reports all nodes measured, pass 2 feeds those measured widths/heights to ELK,
// applies the returned positions, and reveals + fits the graph.
//
// Inline edits (rename a class or a member — see ClassNode.jsx) call
// updateNodeData, which updates a node's `data`; an effect keyed on `nodes`
// rebuilds the spec from live node data and — only when that data actually
// changed (position, selection, and the pass-2 reveal touch node fields but never
// `node.data`) — calls `onChange` with the rebuilt spec. Edges aren't editable,
// so they ride through from the incoming spec verbatim (carrying their `kind`).
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./canvas-theme.css";
import ELK from "elkjs/lib/elk.bundled.js";
import { useEffect, useRef } from "react";
import { nodeTypes } from "./kinds";

/** One ELK instance, reused across layouts (runs on the main thread). */
const elk = new ELK();

/** ELK layered layout knobs — top-down, spaced for a class-diagram feel. */
const LAYOUT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "80",
  "elk.spacing.nodeNode": "60",
};

/** Used only if a node somehow reports no measured size (it always should by pass 2). */
const FALLBACK = { width: 180, height: 80 };

/**
 * Pass 2: build the ELK graph from MEASURED React Flow nodes, run the layout,
 * and return the same nodes repositioned and revealed (opacity 1). Each node's
 * measured width/height (React Flow populates `node.measured` after mount) is fed
 * to ELK; the x/y ELK returns becomes the node `position`.
 */
const layout = async (measuredNodes, edges) => {
  const graph = {
    id: "root",
    layoutOptions: LAYOUT_OPTIONS,
    children: measuredNodes.map((n) => ({
      id: n.id,
      width: n.measured?.width ?? FALLBACK.width,
      height: n.measured?.height ?? FALLBACK.height,
    })),
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
  const laid = await elk.layout(graph);
  const pos = new Map((laid.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
  return measuredNodes.map((n) => ({
    ...n,
    position: pos.get(n.id) ?? n.position,
    style: { ...n.style, opacity: 1 },
  }));
};

function Flow({ spec, onChange }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const { getNodes, fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const laidOut = useRef(false);
  // The loaded spec — its edges carry `kind` and never enter edges-state, so every
  // emit reuses them verbatim. `lastEmitted` baselines change-detection against the
  // loaded node data (the exact objects seeded below) so nothing emits until a real
  // data edit.
  const specRef = useRef(spec);
  const lastEmitted = useRef(spec.nodes);

  // Pass 1: seed unpositioned + hidden from the spec so React Flow can measure.
  useEffect(() => {
    laidOut.current = false;
    specRef.current = spec;
    lastEmitted.current = spec.nodes;
    setNodes(
      spec.nodes.map((n) => ({ id: n.id, type: n.kind, data: n, position: { x: 0, y: 0 }, style: { opacity: 0 } })),
    );
    setEdges(spec.edges.map((e, i) => ({ id: e.id ?? `e${i}`, source: e.source, target: e.target })));
  }, [spec, setNodes, setEdges]);

  // Pass 2: once measured, run ELK, then reveal + fit (guarded to run once per spec).
  useEffect(() => {
    if (!nodesInitialized || laidOut.current) return;
    laidOut.current = true;
    layout(getNodes(), edges).then((positioned) => {
      setNodes(positioned);
      requestAnimationFrame(() => fitView({ padding: 0.2 }));
    });
  }, [nodesInitialized, getNodes, edges, setNodes, fitView]);

  // Emit-back: an inline rename calls updateNodeData, which (in this controlled
  // flow) updates `nodes`, firing this effect. Rebuild the spec from live node DATA
  // only and emit when that data differs by reference from the last-emitted set —
  // so position, selection, and the pass-2 reveal (which change node fields but
  // never `node.data`) don't emit, and no relayout runs. Edges come from specRef so
  // their `kind` survives. The sink (entry.jsx) debounces + persists; we don't.
  useEffect(() => {
    const data = getNodes().map((n) => n.data);
    const prev = lastEmitted.current;
    const changed = data.length !== prev.length || data.some((d, i) => d !== prev[i]);
    if (!changed) return;
    lastEmitted.current = data;
    onChange({ nodes: data, edges: specRef.current.edges });
  }, [nodes, getNodes, onChange]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      minZoom={0.2}
      proOptions={{ hideAttribution: true }}
    >
      <Background />
      <Controls />
    </ReactFlow>
  );
}

/**
 * The diagram renderer. `spec` is a parsed GraphSpec (`{ nodes, edges }`);
 * `onChange(nextSpec)` fires with the rebuilt spec OBJECT whenever the user edits
 * node data. Wraps the canvas in a `ReactFlowProvider` so the hooks in `Flow`
 * (useReactFlow / useNodesInitialized) resolve.
 */
export function DiagramCanvas({ spec, onChange }) {
  return (
    <ReactFlowProvider>
      <Flow spec={spec} onChange={onChange} />
    </ReactFlowProvider>
  );
}

// Re-export the graph contract so a consumer imports the component and its
// validator from one place (planner does exactly this).
export { GraphSpec } from "./kinds/schema";
