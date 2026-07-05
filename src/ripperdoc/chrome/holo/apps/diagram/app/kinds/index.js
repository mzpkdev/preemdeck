// index.js — the `kind` registry.
//
// Each node `kind` maps to a pair: a zod schema (validates/normalizes the spec
// node) + a React Flow node component (renders it). `nodeTypes` is derived from
// the registry and handed to <ReactFlow nodeTypes={...}>, so adding a kind is
// one component file + one line here (extending NodeSpec in lockstep).
//
// This file is untyped `.js` on purpose: it imports the `.jsx` components, and the
// repo keeps JSX out of the type program (no `jsx`/`allowJs` in tsconfig), same as
// entry.jsx. The typed data contract lives in schema.ts, imported directly where
// types are wanted.
import { ActorNode } from "./ActorNode.jsx";
import { ChannelNode } from "./ChannelNode.jsx";
import { ClassNode } from "./ClassNode.jsx";
import { DbNode } from "./DbNode.jsx";
import { EnumNode } from "./EnumNode.jsx";
import { ExternalNode } from "./ExternalNode.jsx";
import { FnNode } from "./FnNode.jsx";
import { GroupNode } from "./GroupNode.jsx";
import { IoNode } from "./IoNode.jsx";
import {
  ActorNodeSpec,
  ChannelNodeSpec,
  ClassNodeSpec,
  DbNodeSpec,
  EnumNodeSpec,
  ExternalNodeSpec,
  FnNodeSpec,
  GroupNodeSpec,
  IoNodeSpec,
} from "./schema";

/** kind → { schema, Node }. Extend with more kinds (extending NodeSpec in lockstep). */
export const nodeKinds = {
  class: { schema: ClassNodeSpec, Node: ClassNode },
  io: { schema: IoNodeSpec, Node: IoNode },
  enum: { schema: EnumNodeSpec, Node: EnumNode },
  fn: { schema: FnNodeSpec, Node: FnNode },
  db: { schema: DbNodeSpec, Node: DbNode },
  actor: { schema: ActorNodeSpec, Node: ActorNode },
  external: { schema: ExternalNodeSpec, Node: ExternalNode },
  channel: { schema: ChannelNodeSpec, Node: ChannelNode },
  group: { schema: GroupNodeSpec, Node: GroupNode },
};

/** kind → component map for React Flow's `nodeTypes` prop, derived from the registry. */
export const nodeTypes = Object.fromEntries(Object.entries(nodeKinds).map(([k, v]) => [k, v.Node]));

// Re-export the zod contracts (runtime values) for convenience.
export { EdgeSpec, GraphSpec, NodeSpec } from "./schema";
