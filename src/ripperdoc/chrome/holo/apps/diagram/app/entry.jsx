// entry.jsx — the holo diagram client. Fetches an agent-authored graph spec
// (a UML class diagram: `{ nodes: [ClassNodeSpec], edges: [EdgeSpec] }`) from
// holo's dev server, validates it with the zod contract, lays it out with ELK,
// and renders it with React Flow custom nodes from the `kind` registry.
//
// Inline edits (rename a class or a member — see ClassNode.jsx) write back:
// updateNodeData mutates a node's `data`, an effect keyed on `nodes` reserialises
// the spec, and — only when the serialised data actually changed — debounces a
// POST to persist the file. serve.ts watches the file and pushes a full reload on
// external change, so this re-fetches and re-lays-out on reload.
//
// Layout is TWO-PASS + MEASURED (ELK does no text measurement, and UML boxes
// size to their content): pass 1 mounts every node hidden (opacity 0) at the
// origin so React Flow measures each rendered box; once `useNodesInitialized`
// reports all nodes measured, pass 2 feeds those measured widths/heights to ELK,
// applies the returned positions, and reveals + fits the graph. This replaces the
// old single-pass FIXED-size layout.
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
import ELK from "elkjs/lib/elk.bundled.js";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@holo-style";
import { nodeTypes } from "./kinds";
import { GraphSpec } from "./kinds/schema";

/** The dev-server endpoint serve.ts mounts: GET returns the graph spec JSON, POST persists it. */
const GRAPH_ENDPOINT = "/__holo/graph";

/** Canonical on-disk form of the spec: pretty JSON + trailing newline (what the server writes). */
const serialize = (spec) => JSON.stringify(spec, null, 2) + "\n";

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

function Flow({ spec }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const { getNodes, fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const laidOut = useRef(false);
  // The full loaded spec — its edges carry `kind` and never enter edges-state, so
  // write-back reuses them verbatim. Baseline the last-sent body against the
  // loaded spec so nothing POSTs until a real data edit.
  const specRef = useRef(spec);
  const lastSentRef = useRef(serialize({ nodes: spec.nodes, edges: spec.edges }));

  // Pass 1: seed unpositioned + hidden from the spec so React Flow can measure.
  useEffect(() => {
    laidOut.current = false;
    specRef.current = spec;
    lastSentRef.current = serialize({ nodes: spec.nodes, edges: spec.edges });
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

  // Write-back: an inline rename calls updateNodeData, which (in this controlled
  // flow) updates `nodes`, firing this effect. Reserialise from node DATA only and
  // POST when it differs from the last body sent — so position, selection, and the
  // pass-2 reveal (which change node fields but never `node.data`) don't persist,
  // and no relayout runs. Edges come from specRef so their `kind` survives the trip.
  useEffect(() => {
    const body = serialize({ nodes: getNodes().map((n) => n.data), edges: specRef.current.edges });
    if (body === lastSentRef.current) return;
    const timer = setTimeout(() => {
      lastSentRef.current = body;
      fetch(GRAPH_ENDPOINT, { method: "POST", body }).catch(() => {});
    }, 300);
    return () => clearTimeout(timer);
  }, [nodes, getNodes]);

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

function App() {
  // { status: "loading" } | { status: "ready", spec } | { status: "error", message }
  const [state, setState] = useState({ status: "loading" });

  useEffect(() => {
    let live = true;
    fetch(GRAPH_ENDPOINT)
      .then((response) => response.json())
      .then((raw) => {
        if (!live) return;
        const parsed = GraphSpec.safeParse(raw);
        if (!parsed.success) {
          setState({ status: "error", message: parsed.error.message });
          return;
        }
        setState({ status: "ready", spec: parsed.data });
      })
      .catch((error) => {
        if (live) setState({ status: "error", message: String(error) });
      });
    return () => {
      live = false;
    };
  }, []);

  if (state.status === "loading") return null;
  if (state.status === "error") return <div className="holo-error">holo: {state.message}</div>;

  return (
    <ReactFlowProvider>
      <Flow spec={state.spec} />
    </ReactFlowProvider>
  );
}

createRoot(document.getElementById("root")).render(<App />);
