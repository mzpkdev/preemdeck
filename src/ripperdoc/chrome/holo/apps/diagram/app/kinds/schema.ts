/**
 * schema.ts — zod contracts for the diagram graph spec.
 *
 * Node data is STRUCTURED, not preformatted strings: the renderer reads
 * `{vis, name, type}` members, pins, enum values etc. off the parsed node and
 * lays the compartments out itself (so it can colour the visibility glyph,
 * italicise abstract names, anchor edges to pins, etc.). `NodeSpec` is a
 * `discriminatedUnion` on `kind` — nine kinds, one primitive vocabulary for
 * class AND component/architecture diagrams; adding a kind = one union member
 * here + one component + one registry line (kinds/index.js). Edges render
 * through the edge registry (../edges/visuals.ts): each `kind` draws its own
 * marker/dash/colour, with the convention that `source` is the parent / owner
 * / whole / caller — structural kinds wear their marker at the source end,
 * flow kinds at the target end.
 *
 * The whole document is cross-checked after parse (`superRefine`): an edge
 * endpoint that names a missing node fails the parse LOUDLY (the hosts render
 * an inline `holo: <message>`) instead of silently drawing nothing — the
 * failure mode that actually helps an agent authoring JSON.
 */

import { z } from "zod"

/** UML member visibility glyphs: public / private / protected / package. */
export const Visibility = z.enum(["+", "-", "#", "~"])

/** A class attribute, rendered `‹vis› name: type` (type optional). */
export const Attribute = z.object({
    vis: Visibility.default("+"),
    name: z.string(),
    type: z.string().optional()
})

/** A class method, rendered `‹vis› name(params): type` (params + type optional). */
export const Method = z.object({
    vis: Visibility.default("+"),
    name: z.string(),
    params: z.string().optional(),
    type: z.string().optional()
})

/**
 * Fields every node kind shares. `group` claims membership in a
 * `kind:"group"` boundary (validated once the group kind lands); `border`
 * opts into the purple "distinct" highlight — an enum-of-one, not a boolean,
 * so more variants stay an additive change. Optional fields carry NO zod
 * defaults on purpose: the canvas writes parsed output back into the plan
 * file, and defaults would stamp noise onto every node.
 */
export const NodeBase = z.object({
    id: z.string(),
    group: z.string().optional(),
    border: z.enum(["distinct"]).optional()
})

/**
 * A UML class box. `stereotype` is free-form («interface», «singleton»,
 * «store», …) and always renders as the guillemet header line;
 * `abstract`/`interface` additionally italicise the name.
 */
export const ClassNodeSpec = NodeBase.extend({
    kind: z.literal("class"),
    name: z.string(),
    stereotype: z.string().optional(),
    attributes: z.array(Attribute).default([]),
    methods: z.array(Method).default([])
})

/**
 * An io-node pin. A pin that declares an `id` becomes an addressable React
 * Flow handle: edges may anchor to it via `sourcePort` (output pins) /
 * `targetPort` (input pins). `label` is the display text; `binding` the small
 * protocol tag (http / grpc / event / …).
 */
export const Pin = z.object({
    id: z.string().optional(),
    label: z.string(),
    binding: z.string().optional()
})

/** A component/service with typed ports: in-pins (blue dots) and out-pins (orange). */
export const IoNodeSpec = NodeBase.extend({
    kind: z.literal("io"),
    name: z.string(),
    stereotype: z.string().optional(),
    inputs: z.array(Pin).default([]),
    outputs: z.array(Pin).default([])
})

/** An «enumeration» box: cut-corner silhouette; values render with ordinals derived from array index. */
export const EnumNodeSpec = NodeBase.extend({
    kind: z.literal("enum"),
    name: z.string(),
    values: z.array(z.string()).default([])
})

/** A function/hook pill; `name` holds the whole signature (`createShape(kind): Shape`). */
export const FnNodeSpec = NodeBase.extend({
    kind: z.literal("fn"),
    name: z.string()
})

/** A datastore cylinder; `engine` is the small subtitle (postgres / sqlite / browser / …). */
export const DbNodeSpec = NodeBase.extend({
    kind: z.literal("db"),
    name: z.string(),
    engine: z.string().optional()
})

/** A person (C4 actor): stick figure, «actor» tag fixed chrome. */
export const ActorNodeSpec = NodeBase.extend({
    kind: z.literal("actor"),
    name: z.string()
})

/** A system you do not own: dashed box, «external» tag fixed chrome. */
export const ExternalNodeSpec = NodeBase.extend({
    kind: z.literal("external"),
    name: z.string()
})

/** An async conduit (queue / topic / stream / bus); `transport` renders uppercase, defaulting to "topic". */
export const ChannelNodeSpec = NodeBase.extend({
    kind: z.literal("channel"),
    name: z.string(),
    transport: z.string().optional()
})

/**
 * A boundary frame that CONTAINS nodes (module / context / namespace).
 * Membership lives on the members (`group: <this id>`), never on the group;
 * the frame has no size fields — ELK computes it from the children plus
 * padding. The label tab renders `«stereotype ?? boundary» name`.
 */
export const GroupNodeSpec = NodeBase.extend({
    kind: z.literal("group"),
    name: z.string(),
    stereotype: z.string().optional()
})

/** The node union, discriminated on `kind`; extend with more kinds later. */
export const NodeSpec = z.discriminatedUnion("kind", [
    ClassNodeSpec,
    IoNodeSpec,
    EnumNodeSpec,
    FnNodeSpec,
    DbNodeSpec,
    ActorNodeSpec,
    ExternalNodeSpec,
    ChannelNodeSpec,
    GroupNodeSpec
])

/**
 * The edge relationship vocabulary: the six UML kinds plus the two flow
 * overlays (`call` = sync, `event` = async through a channel).
 */
export const EdgeKind = z.enum([
    "association",
    "dependency",
    "inheritance",
    "realization",
    "aggregation",
    "composition",
    "call",
    "event"
])

/**
 * A directed edge. Convention: `source` is the parent / owner / whole / caller
 * — so `animal → dog` is `inheritance`, and the hollow triangle renders at the
 * SOURCE end. `label` is load-bearing for the flow kinds (the same `kind`
 * reads differently as "props down" vs "owns"). `sourcePort`/`targetPort`
 * anchor an end to a declared io-node pin id (inert until the io kind lands).
 */
export const EdgeSpec = z.object({
    id: z.string().optional(),
    source: z.string(),
    target: z.string(),
    kind: EdgeKind.default("association"),
    label: z.string().optional(),
    sourcePort: z.string().optional(),
    targetPort: z.string().optional()
})

/**
 * Graph-level layout hints. Positions stay ELK-computed and ephemeral —
 * `direction` picks the flow axis (class hierarchies read DOWN, io-pin
 * topologies usually RIGHT), `spacing` the node gap (default 60, layer gap
 * keeps the 4/3 ratio).
 */
export const LayoutHints = z.object({
    direction: z.enum(["DOWN", "UP", "RIGHT", "LEFT"]).optional(),
    spacing: z.number().positive().optional()
})

/** The whole graph document: the agent authors it, serve.ts serves it, the page renders it. */
export const GraphSpec = z
    .object({
        nodes: z.array(NodeSpec),
        edges: z.array(EdgeSpec).default([]),
        layout: LayoutHints.optional()
    })
    .superRefine((graph, ctx) => {
        const byId = new Map(graph.nodes.map((n) => [n.id, n]))
        graph.nodes.forEach((node, i) => {
            if (node.group === undefined) return
            const parent = byId.get(node.group)
            if (node.group === node.id || parent === undefined || parent.kind !== "group") {
                ctx.addIssue({
                    code: "custom",
                    path: ["nodes", i, "group"],
                    message: `node "${node.id}" group "${node.group}" is not another group node's id`
                })
                return
            }
            // Membership chains must stay acyclic (a cycle would hang the layout).
            const seen = new Set([node.id])
            let cursor: string | undefined = node.group
            while (cursor !== undefined) {
                if (seen.has(cursor)) {
                    ctx.addIssue({
                        code: "custom",
                        path: ["nodes", i, "group"],
                        message: `group membership cycle through "${cursor}"`
                    })
                    break
                }
                seen.add(cursor)
                cursor = byId.get(cursor)?.group
            }
        })
        const hasPin = (nodeId: string, key: "inputs" | "outputs", pin: string): boolean => {
            const node = byId.get(nodeId)
            return node?.kind === "io" && node[key].some((p) => p.id === pin)
        }
        graph.edges.forEach((edge, i) => {
            const name = edge.id ?? `#${i}`
            for (const end of ["source", "target"] as const) {
                if (!byId.has(edge[end])) {
                    ctx.addIssue({
                        code: "custom",
                        path: ["edges", i, end],
                        message: `edge ${name} ${end} "${edge[end]}" is not a node id`
                    })
                }
            }
            if (edge.sourcePort !== undefined && !hasPin(edge.source, "outputs", edge.sourcePort)) {
                ctx.addIssue({
                    code: "custom",
                    path: ["edges", i, "sourcePort"],
                    message: `edge ${name} sourcePort "${edge.sourcePort}" is not a declared output pin id on "${edge.source}"`
                })
            }
            if (edge.targetPort !== undefined && !hasPin(edge.target, "inputs", edge.targetPort)) {
                ctx.addIssue({
                    code: "custom",
                    path: ["edges", i, "targetPort"],
                    message: `edge ${name} targetPort "${edge.targetPort}" is not a declared input pin id on "${edge.target}"`
                })
            }
        })
    })

/** Parsed (output) shape of a class node — what the `ClassNode` component receives as `data`. */
export type ClassNodeData = z.infer<typeof ClassNodeSpec>
