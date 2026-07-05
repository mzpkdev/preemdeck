/**
 * edge-ops.ts — pure reducers/validators behind edge canvas editing.
 *
 * DiagramCanvas wires React Flow's connect/delete events straight through
 * these: `isValidConnection` gates the drag, `applyConnect` turns a drop into
 * a new `holo` edge (normalized so pins keep their direction semantics),
 * `nextKind` powers the selected-edge kind cycler. Everything is DOM-free and
 * structural, so `bun test` pins the whole editing grammar.
 *
 * Pin direction rules (io nodes): an in-pin is always the TARGET end of an
 * edge, an out-pin always the SOURCE end. React Flow runs connections in
 * Loose mode (any handle to any handle) so a user may drag from either end —
 * `normalizeConnection` swaps a backwards drag instead of rejecting it; only
 * in↔in and out↔out are invalid. Side anchors (non-pin handles) are drawing
 * affordances and never persist: `applyConnect` strips them so the spec keeps
 * node-level endpoints.
 */

import { EdgeKind } from "../kinds/schema"
import type { SeededEdge } from "../spec-sync"
import type { EdgeKindName } from "./visuals"

/** The slice of a React Flow connection the ops read. */
export type Connection = {
    source: string | null
    target: string | null
    sourceHandle?: string | null
    targetHandle?: string | null
}

/** What the connect ops need to know about the graph: node kinds and pin bindings. */
export type ConnectCtx = {
    kindOf: (nodeId: string) => string | undefined
    pinBinding: (nodeId: string, handle: string) => string | undefined
}

type PinLike = { id?: string; binding?: string }

const pinsOf = (data: unknown, key: "inputs" | "outputs"): PinLike[] => {
    if (typeof data !== "object" || data === null) return []
    const pins = (data as Record<string, unknown>)[key]
    return Array.isArray(pins) ? (pins as PinLike[]) : []
}

/** Build a ConnectCtx from live React Flow nodes (each carries its spec node in `data`). */
export const connectCtx = (nodes: ReadonlyArray<{ id: string; data?: unknown }>): ConnectCtx => {
    const byId = new Map(nodes.map((n) => [n.id, n.data]))
    return {
        kindOf: (nodeId) => {
            const data = byId.get(nodeId)
            if (typeof data !== "object" || data === null) return undefined
            const kind = (data as Record<string, unknown>).kind
            return typeof kind === "string" ? kind : undefined
        },
        pinBinding: (nodeId, handle) => {
            const port = handle.startsWith("out:") ? handle.slice(4) : handle.startsWith("in:") ? handle.slice(3) : ""
            if (port === "") return undefined
            const key = handle.startsWith("out:") ? "outputs" : "inputs"
            const pin = pinsOf(byId.get(nodeId), key).find((p) => p.id === port)
            return pin?.binding
        }
    }
}

const isInHandle = (handle: string | null | undefined): boolean => handle?.startsWith("in:") ?? false
const isOutHandle = (handle: string | null | undefined): boolean => handle?.startsWith("out:") ?? false

/**
 * A connection is drawable when it isn't a self-loop (explicit non-goal), no
 * end is a group frame (containers, not endpoints), and pin directions don't
 * clash (in↔in, out↔out). A backwards drag is fine — normalization flips it.
 */
export const isValidConnection = (connection: Connection, ctx: ConnectCtx): boolean => {
    const { source, target, sourceHandle, targetHandle } = connection
    if (source === null || target === null || source === target) return false
    if (ctx.kindOf(source) === "group" || ctx.kindOf(target) === "group") return false
    if (isInHandle(sourceHandle) && isInHandle(targetHandle)) return false
    if (isOutHandle(sourceHandle) && isOutHandle(targetHandle)) return false
    return true
}

/**
 * Flip a backwards drag so pins keep their semantics: an in-pin end becomes
 * the target, an out-pin end the source. (After `isValidConnection`, at most
 * one swap applies.)
 */
export const normalizeConnection = (connection: Connection): Connection => {
    const backwards = isInHandle(connection.sourceHandle) || isOutHandle(connection.targetHandle)
    if (!backwards) return connection
    return {
        source: connection.target,
        target: connection.source,
        sourceHandle: connection.targetHandle,
        targetHandle: connection.sourceHandle
    }
}

/** The next id in the `e<n>` series that collides with nothing (deterministic — no clocks, no randomness). */
export const genEdgeId = (existing: ReadonlySet<string>): string => {
    let n = existing.size
    while (existing.has(`e${n}`)) n++
    return `e${n}`
}

/** Cycle order for the selected-edge kind chip: the catalog order, wrapping. */
export const nextKind = (kind: EdgeKindName): EdgeKindName => {
    const order = EdgeKind.options
    const at = order.indexOf(kind)
    return order[(at + 1) % order.length] ?? "association"
}

/**
 * The default kind for a hand-drawn edge, inferred from its endpoints — the
 * demos' idioms: anything touching a channel (or an `event` pin) flows async,
 * an `http`/`grpc` out-pin is a call, writing into a datastore is ownership.
 * The user corrects via the kind cycler; this just makes the common case
 * zero-click.
 */
export const defaultEdgeKind = (args: {
    sourceKind?: string
    targetKind?: string
    sourceBinding?: string
    targetBinding?: string
}): EdgeKindName => {
    const { sourceKind, targetKind, sourceBinding, targetBinding } = args
    if (sourceKind === "channel" || targetKind === "channel") return "event"
    if (sourceBinding === "event" || targetBinding === "event") return "event"
    if (sourceBinding === "http" || sourceBinding === "grpc") return "call"
    if (targetKind === "db") return "composition"
    return "association"
}

/**
 * Turn a dropped connection into the edges array with one new `holo` edge
 * appended: normalized ends, a generated persistent id, inferred kind, port
 * handles kept, side/node handles stripped. Returns the input unchanged when
 * the connection is unusable.
 */
export const applyConnect = (edges: readonly SeededEdge[], connection: Connection, ctx: ConnectCtx): SeededEdge[] => {
    const normalized = normalizeConnection(connection)
    const { source, target } = normalized
    if (source === null || target === null) return [...edges]
    const sourceHandle =
        normalized.sourceHandle !== null &&
        normalized.sourceHandle !== undefined &&
        isOutHandle(normalized.sourceHandle)
            ? normalized.sourceHandle
            : undefined
    const targetHandle =
        normalized.targetHandle !== null && normalized.targetHandle !== undefined && isInHandle(normalized.targetHandle)
            ? normalized.targetHandle
            : undefined
    const kind = defaultEdgeKind({
        sourceKind: ctx.kindOf(source),
        targetKind: ctx.kindOf(target),
        sourceBinding: sourceHandle === undefined ? undefined : ctx.pinBinding(source, sourceHandle),
        targetBinding: targetHandle === undefined ? undefined : ctx.pinBinding(target, targetHandle)
    })
    return [
        ...edges,
        {
            id: genEdgeId(new Set(edges.map((e) => e.id))),
            source,
            target,
            sourceHandle,
            targetHandle,
            type: "holo",
            data: { kind, label: undefined, autoId: false }
        }
    ]
}
