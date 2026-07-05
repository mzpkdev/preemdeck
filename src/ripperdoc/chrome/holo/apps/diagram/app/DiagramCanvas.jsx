// DiagramCanvas.jsx — the source-agnostic diagram renderer.
//
// Takes a parsed GraphSpec in (`{ nodes, edges }`) and emits the edited spec out
// via `onChange` — it knows nothing about WHERE the spec came from or where edits
// go. holo's standalone client (entry.jsx) fetches/POSTs the spec around it;
// planner reuses the same component against its own source. So this file has NO
// fetch, NO POST, NO debounce, NO JSON — pure spec-in / onChange-out. The
// deterministic pieces live in pure modules: spec ⇄ React Flow conversions in
// spec-sync.ts, the ELK graph builders in layout/elk-graph.ts; this file is the
// orchestration and the React state.
//
// Layout is TWO-PASS + MEASURED (ELK does no text measurement, and UML boxes
// size to their content): pass 1 mounts every node hidden (opacity 0) at the
// origin so React Flow measures each rendered box; once `useNodesInitialized`
// reports all nodes measured, pass 2 feeds those measured widths/heights to ELK,
// applies the returned positions, and reveals + fits the graph.
//
// Inline edits (rename a class or a member — see ClassNode.jsx) call
// updateNodeData, which updates a node's `data`; edges live in React Flow
// state as the custom `holo` type (kind + label in `data`, markers/dash/colour
// from the edge registry in edges/visuals.ts). One effect keyed on
// `[nodes, edges]` rebuilds the spec from live state and emits only when
// something REAL changed — node `data` by reference, edges by
// endpoints/handles + `data` reference — so position, selection, and the
// pass-2 reveal never rewrite the plan file (see spec-sync.ts for the guards).
import {
  Background,
  ConnectionMode,
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
import "./theme/tokens.css";
import ELK from "elkjs/lib/elk.bundled.js";
import { useCallback, useEffect, useRef } from "react";
import { applyConnect, connectCtx, isValidConnection } from "./edges/edge-ops";
import { HoloEdge } from "./edges/HoloEdge";
import { MarkerDefs } from "./edges/MarkerDefs";
import { nodeTypes } from "./kinds";
import { applyElkPositions, buildElkGraph } from "./layout/elk-graph";
import {
  changedSinceBaseline,
  edgesChangedSinceBaseline,
  projectEdges,
  reparentChildren,
  seedEdges,
  seedNodes,
} from "./spec-sync";

/** The one custom edge component; every seeded/drawn edge is `type: "holo"`. */
const edgeTypes = { holo: HoloEdge };

/** One ELK instance, reused across layouts (runs on the main thread). */
const elk = new ELK();

/** Pass 2: run ELK over the MEASURED nodes (nested when groups exist), then reposition + reveal them. */
const layout = async (measuredNodes, edges, hints) =>
  applyElkPositions(await elk.layout(buildElkGraph(measuredNodes, edges, hints)), measuredNodes);

function Flow({ spec, onChange }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const { getNodes, fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const laidOut = useRef(false);
  // Emission baselines, seeded from the exact objects handed to React Flow
  // below, so nothing emits until a real edit swaps something out.
  const lastEmittedNodes = useRef(spec.nodes);
  const lastEmittedEdges = useRef([]);

  // Pass 1: seed unpositioned + hidden from the spec so React Flow can measure.
  // Baselines take the SEEDED arrays (seeding sorts parents first, so the
  // author's node order may differ — baselining the sorted data keeps the
  // mount silent either way).
  useEffect(() => {
    laidOut.current = false;
    const seededNodes = seedNodes(spec.nodes);
    const seededEdges = seedEdges(spec.edges);
    lastEmittedNodes.current = seededNodes.map((n) => n.data);
    lastEmittedEdges.current = seededEdges;
    setNodes(seededNodes);
    setEdges(seededEdges);
  }, [spec, setNodes, setEdges]);

  // Pass 2: once measured, run ELK, then reveal + fit (guarded to run once per spec).
  useEffect(() => {
    if (!nodesInitialized || laidOut.current) return;
    laidOut.current = true;
    layout(getNodes(), edges, spec.layout).then((positioned) => {
      setNodes(positioned);
      requestAnimationFrame(() => fitView({ padding: 0.2 }));
    });
  }, [nodesInitialized, getNodes, edges, spec, setNodes, fitView]);

  // Deleting a group keeps its children: reparent them to the nearest
  // surviving ancestor (their `data.group` rewrite emits the membership
  // change) before React Flow removes the frame.
  const onBeforeDelete = useCallback(
    async ({ nodes: doomed }) => {
      const goneGroups = new Set(doomed.filter((n) => n.type === "group").map((n) => n.id));
      if (goneGroups.size > 0) setNodes((nds) => reparentChildren(nds, goneGroups));
      return true;
    },
    [setNodes],
  );

  // Edge drawing: Loose mode lets any handle start a connection (the ops
  // normalize direction); validity and the applied edge are pure edge-ops.
  const onConnect = useCallback(
    (connection) => setEdges((eds) => applyConnect(eds, connection, connectCtx(getNodes()))),
    [setEdges, getNodes],
  );
  const validConnection = useCallback(
    (connection) => isValidConnection(connection, connectCtx(getNodes())),
    [getNodes],
  );

  // Emit-back: inline edits (updateNodeData) and edge mutations both land in
  // React Flow state and fire this effect. Rebuild the spec from live state and
  // emit only when the guards trip — node `data` by reference, edges by
  // endpoints/handles + `data` reference — so position, selection, and the
  // pass-2 reveal don't emit, and no relayout runs. The sink (entry.jsx)
  // debounces + persists; we don't.
  useEffect(() => {
    const data = getNodes().map((n) => n.data);
    const nodesDirty = changedSinceBaseline(data, lastEmittedNodes.current);
    const edgesDirty = edgesChangedSinceBaseline(edges, lastEmittedEdges.current);
    if (!nodesDirty && !edgesDirty) return;
    lastEmittedNodes.current = data;
    lastEmittedEdges.current = edges;
    onChange({
      nodes: data,
      edges: projectEdges(edges),
      ...(spec.layout === undefined ? {} : { layout: spec.layout }),
    });
  }, [nodes, edges, getNodes, spec, onChange]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      isValidConnection={validConnection}
      onBeforeDelete={onBeforeDelete}
      connectionMode={ConnectionMode.Loose}
      deleteKeyCode={["Backspace", "Delete"]}
      minZoom={0.2}
      proOptions={{ hideAttribution: true }}
    >
      <MarkerDefs />
      <Background gap={20} size={1} />
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
