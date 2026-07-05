/**
 * spec-sync.ts — pure GraphSpec ⇄ React Flow state conversions.
 *
 * `seedNodes`/`seedEdges` build the arrays DiagramCanvas hands to React Flow on
 * mount: pass 1 of the two-pass layout seeds every node HIDDEN at the origin so
 * React Flow can measure the rendered boxes before ELK positions them. Edges
 * are FIRST-CLASS React Flow state (they can be drawn, retyped, relabelled and
 * deleted on canvas): each seeds as the custom `holo` edge type carrying
 * `{ kind, label }` in `data`, and `projectEdges` is the exact inverse — what
 * the emission writes back into the spec. A spec edge that declared no `id`
 * gets a positional one for React Flow's sake but projects back id-less
 * (`autoId`), so seeding alone never rewrites the plan file.
 *
 * `changedSinceBaseline`/`edgesChangedSinceBaseline` are the emission guards:
 * node `data` compares by REFERENCE, edges by endpoint/handle value + `data`
 * reference — so position, selection, and the pass-2 reveal (which clone
 * wrappers but never `data`) stay silent, and every real edit emits. No React
 * Flow imports — inputs are structural — so `bun test` reaches all of this
 * without a DOM.
 */

import type { z } from "zod"
import type { EdgeKindName } from "./edges/visuals"
import type { EdgeSpec, GraphSpec } from "./kinds/schema"

export type Graph = z.output<typeof GraphSpec>
export type GraphNode = Graph["nodes"][number]
export type GraphEdge = z.output<typeof EdgeSpec>

/** A spec node as seeded into React Flow: `type` = kind, hidden at the origin for the measure pass. */
export type SeededNode = {
    id: string
    type: GraphNode["kind"]
    data: GraphNode
    position: { x: number; y: number }
    style: { opacity: number }
    parentId?: string
    extent?: "parent"
}

/** What a `holo` edge carries in React Flow state; `autoId` marks a seeded id the spec never declared. */
export type EdgeData = {
    kind: EdgeKindName
    label?: string
    autoId: boolean
}

/** A spec edge as seeded into React Flow: the custom `holo` type + `data` payload. */
export type SeededEdge = {
    id: string
    source: string
    target: string
    sourceHandle?: string
    targetHandle?: string
    type: "holo"
    data: EdgeData
}

/** The slice of a React Flow edge the projection reads (selection flags etc. are ignored). */
export type FlowEdgeLike = {
    id: string
    source: string
    target: string
    sourceHandle?: string | null
    targetHandle?: string | null
    data?: EdgeData
}

/**
 * Stable parents-first order: React Flow hard-requires a `parentId` target to
 * appear before its children in the nodes array. Nodes keep their relative
 * order otherwise. (Membership cycles are rejected by the schema; the
 * emergency break below just guarantees termination on malformed input.)
 */
const sortParentsFirst = (nodes: readonly GraphNode[]): GraphNode[] => {
    const emitted = new Set<string>()
    const out: GraphNode[] = []
    const pending = [...nodes]
    while (pending.length > 0) {
        const before = out.length
        for (let i = 0; i < pending.length; ) {
            const node = pending[i]
            if (node !== undefined && (node.group === undefined || emitted.has(node.group))) {
                out.push(node)
                emitted.add(node.id)
                pending.splice(i, 1)
            } else {
                i++
            }
        }
        if (out.length === before) {
            out.push(...pending)
            break
        }
    }
    return out
}

/**
 * Pass-1 seed, parents-first. `data` keeps the exact spec-node object (by
 * reference) — the emission baseline is seeded from these same sorted objects,
 * so nothing emits until an inline edit swaps one out via updateNodeData.
 * `group` membership becomes React Flow's `parentId` (+ `extent: "parent"` so
 * ephemeral drags can't pull a member outside its frame).
 */
export const seedNodes = (nodes: readonly GraphNode[]): SeededNode[] =>
    sortParentsFirst(nodes).map((n) => ({
        id: n.id,
        type: n.kind,
        data: n,
        position: { x: 0, y: 0 },
        style: { opacity: 0 },
        ...(n.group === undefined ? {} : { parentId: n.group, extent: "parent" as const })
    }))

/** The slice of a React Flow node `reparentChildren` reads/writes. */
export type FlowNodeLike = {
    id: string
    parentId?: string
    extent?: "parent"
    position: { x: number; y: number }
    data: GraphNode
}

/**
 * Deleting a group must keep its children: each child of a doomed group climbs
 * to the nearest SURVIVING ancestor (or the root), its absolute position
 * preserved by folding in the deleted frames' offsets, and its `data.group`
 * membership rewritten (a NEW data object — membership is spec, so this edit
 * must emit).
 */
export const reparentChildren = (nodes: readonly FlowNodeLike[], goneGroupIds: ReadonlySet<string>): FlowNodeLike[] => {
    const byId = new Map(nodes.map((n) => [n.id, n]))
    return nodes.map((n) => {
        if (n.parentId === undefined || !goneGroupIds.has(n.parentId)) return n
        let { x, y } = n.position
        let ancestor = byId.get(n.parentId)
        while (ancestor !== undefined && goneGroupIds.has(ancestor.id)) {
            x += ancestor.position.x
            y += ancestor.position.y
            ancestor = ancestor.parentId === undefined ? undefined : byId.get(ancestor.parentId)
        }
        const nextParent = ancestor?.id
        return {
            ...n,
            parentId: nextParent,
            extent: nextParent === undefined ? undefined : ("parent" as const),
            position: { x, y },
            data: { ...n.data, group: nextParent }
        }
    })
}

/** The React Flow handle id of an io-node pin, by the end it serves: out-pins feed sources, in-pins targets. */
export const sourcePortHandle = (port: string): string => `out:${port}`
export const targetPortHandle = (port: string): string => `in:${port}`

/** The pin id inside a port handle id, or undefined for node-level/side handles (`a-top` …). */
const portFromHandle = (handle: string | null | undefined, prefix: "out:" | "in:"): string | undefined =>
    handle?.startsWith(prefix) ? handle.slice(prefix.length) : undefined

/**
 * Seed edges as `holo` React Flow edges. A spec edge without an `id` gets a
 * positional `e<i>` (React Flow needs one) marked `autoId` so the projection
 * drops it again. Declared ports become handle ids (`out:`/`in:` prefixed).
 */
export const seedEdges = (edges: readonly GraphEdge[]): SeededEdge[] =>
    edges.map((e, i) => ({
        id: e.id ?? `e${i}`,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourcePort === undefined ? undefined : sourcePortHandle(e.sourcePort),
        targetHandle: e.targetPort === undefined ? undefined : targetPortHandle(e.targetPort),
        type: "holo",
        data: { kind: e.kind, label: e.label, autoId: e.id === undefined }
    }))

/**
 * The inverse of `seedEdges`: live React Flow edges → spec edges. Only port
 * handles (`out:`/`in:`) persist as ports; side-anchor handles are drawing
 * affordances and are dropped. `undefined` fields vanish on JSON.stringify, so
 * the written spec stays as lean as the author's.
 */
export const projectEdges = (edges: readonly FlowEdgeLike[]): GraphEdge[] =>
    edges.map((e) => ({
        id: e.data?.autoId ? undefined : e.id,
        source: e.source,
        target: e.target,
        kind: e.data?.kind ?? "association",
        label: e.data?.label,
        sourcePort: portFromHandle(e.sourceHandle, "out:"),
        targetPort: portFromHandle(e.targetHandle, "in:")
    }))

/**
 * The node emission guard: true when the projected node data differs from the
 * baseline by length or by element REFERENCE. Reference equality is the whole
 * contract — layout, drag, selection and the pass-2 reveal all clone the node
 * wrapper but reuse `data`, so they never trip this.
 */
export const changedSinceBaseline = (data: readonly unknown[], baseline: readonly unknown[]): boolean =>
    data.length !== baseline.length || data.some((d, i) => d !== baseline[i])

/**
 * The edge emission guard: endpoints/handles by value, `data` by reference.
 * Selection clones the edge object but keeps all of these — silent. Create,
 * delete, retype (new `data`), relabel (new `data`) — all trip it.
 */
export const edgesChangedSinceBaseline = (edges: readonly FlowEdgeLike[], baseline: readonly FlowEdgeLike[]): boolean =>
    edges.length !== baseline.length ||
    edges.some((e, i) => {
        const b = baseline[i]
        return (
            b === undefined ||
            e.id !== b.id ||
            e.source !== b.source ||
            e.target !== b.target ||
            (e.sourceHandle ?? null) !== (b.sourceHandle ?? null) ||
            (e.targetHandle ?? null) !== (b.targetHandle ?? null) ||
            e.data !== b.data
        )
    })
