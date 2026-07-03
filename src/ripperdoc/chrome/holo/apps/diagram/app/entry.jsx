// entry.jsx — the holo diagram client: the HTTP wiring around DiagramCanvas.
//
// Fetches an agent-authored graph spec (a UML class diagram:
// `{ nodes: [ClassNodeSpec], edges: [EdgeSpec] }`) from holo's dev server,
// validates it with the zod contract, and hands it to DiagramCanvas — the
// source-agnostic renderer that lays out + draws the graph and emits edits back.
//
// DiagramCanvas knows nothing about transport; this shell is the sink. Its
// `onChange` (an edit rebuilt the spec) debounces a POST that persists the file.
// serve.ts watches the file and pushes a full reload on external change, so an
// agent rewrite re-fetches and re-lays-out here; the server suppresses the reload
// echo of our own POST.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@holo-style";
import { DiagramCanvas, GraphSpec } from "./DiagramCanvas";

/** The dev-server endpoint serve.ts mounts: GET returns the graph spec JSON, POST persists it. */
const GRAPH_ENDPOINT = "/__holo/graph";

/** Canonical on-disk form of the spec: pretty JSON + trailing newline (what the server writes). */
const serialize = (spec) => JSON.stringify(spec, null, 2) + "\n";

function App() {
  // { status: "loading" } | { status: "ready", spec } | { status: "error", message }
  const [state, setState] = useState({ status: "loading" });
  // Debounce handle for the write-back POST, held across edits so a burst coalesces.
  const timer = useRef(null);

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

  // The sink for DiagramCanvas edits: serialise the rebuilt spec and debounce a
  // POST (~300ms) so a burst of inline edits persists once. Stable identity so it
  // never re-triggers the canvas's emit effect.
  const persist = useRef((nextSpec) => {
    const body = serialize(nextSpec);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      fetch(GRAPH_ENDPOINT, { method: "POST", body }).catch(() => {});
    }, 300);
  }).current;

  if (state.status === "loading") return null;
  if (state.status === "error") return <div className="holo-error">holo: {state.message}</div>;

  return <DiagramCanvas spec={state.spec} onChange={persist} />;
}

createRoot(document.getElementById("root")).render(<App />);
