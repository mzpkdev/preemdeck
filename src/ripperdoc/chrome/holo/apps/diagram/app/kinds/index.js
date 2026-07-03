// index.js — the `kind` registry.
//
// Each node `kind` maps to a pair: a zod schema (validates/normalizes the spec
// node) + a React Flow node component (renders it). `nodeTypes` is derived from
// the registry and handed to <ReactFlow nodeTypes={...}>, so adding a kind later
// is one component file + one line here. Seeded with `class` only.
//
// This file is untyped `.js` on purpose: it imports the `.jsx` component, and the
// repo keeps JSX out of the type program (no `jsx`/`allowJs` in tsconfig), same as
// entry.jsx. The typed data contract lives in schema.ts, imported directly where
// types are wanted.
import { ClassNode } from "./ClassNode.jsx";
import { ClassNodeSpec } from "./schema";

/** kind → { schema, Node }. Extend with more kinds (extending NodeSpec in lockstep). */
export const nodeKinds = { class: { schema: ClassNodeSpec, Node: ClassNode } };

/** kind → component map for React Flow's `nodeTypes` prop, derived from the registry. */
export const nodeTypes = Object.fromEntries(Object.entries(nodeKinds).map(([k, v]) => [k, v.Node]));

// Re-export the zod contracts (runtime values) for convenience.
export { EdgeSpec, GraphSpec, NodeSpec } from "./schema";
