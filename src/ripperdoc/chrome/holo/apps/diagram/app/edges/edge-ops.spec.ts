/**
 * edge-ops.spec.ts — the edge editing grammar.
 *
 * Pins connection validity (no self-loops, no group endpoints, no in↔in /
 * out↔out), backwards-drag normalization, the persistent-id generator, the
 * kind cycle order, default-kind inference, and the applyConnect reducer's
 * output shape (side handles stripped, port handles kept).
 */

import { describe, expect, it } from "bun:test"
import { GraphSpec } from "../kinds/schema"
import { seedEdges, seedNodes } from "../spec-sync"
import {
    applyConnect,
    connectCtx,
    defaultEdgeKind,
    genEdgeId,
    isValidConnection,
    nextKind,
    normalizeConnection
} from "./edge-ops"

const spec = GraphSpec.parse({
    nodes: [
        { id: "a", kind: "class", name: "A" },
        { id: "b", kind: "class", name: "B" }
    ],
    edges: [{ id: "e0", source: "a", target: "b", kind: "inheritance" }]
})

// A ctx over plain data shapes — io pins ride through untyped data on purpose
// (the io kind lands later; the ops already understand its inputs/outputs).
const ctx = connectCtx([
    ...seedNodes(spec.nodes),
    { id: "grp", data: { id: "grp", kind: "group", name: "G" } },
    { id: "chan", data: { id: "chan", kind: "channel", name: "orders" } },
    { id: "store", data: { id: "store", kind: "db", name: "DB" } },
    {
        id: "svc",
        data: {
            id: "svc",
            kind: "io",
            name: "Svc",
            inputs: [{ id: "req", label: "POST /x", binding: "http" }],
            outputs: [
                { id: "evt", label: "Created", binding: "event" },
                { id: "pay", label: "Pay", binding: "grpc" }
            ]
        }
    }
])

describe("isValidConnection", () => {
    it("rejects self-loops, group endpoints, and missing ends", () => {
        expect(isValidConnection({ source: "a", target: "a" }, ctx)).toBe(false)
        expect(isValidConnection({ source: "a", target: "grp" }, ctx)).toBe(false)
        expect(isValidConnection({ source: null, target: "a" }, ctx)).toBe(false)
        expect(isValidConnection({ source: "a", target: "b" }, ctx)).toBe(true)
    })

    it("rejects same-direction pin pairs but allows backwards drags", () => {
        expect(
            isValidConnection({ source: "svc", target: "b", sourceHandle: "in:req", targetHandle: "in:x" }, ctx)
        ).toBe(false)
        expect(
            isValidConnection({ source: "svc", target: "b", sourceHandle: "out:evt", targetHandle: "out:y" }, ctx)
        ).toBe(false)
        expect(isValidConnection({ source: "svc", target: "b", sourceHandle: "in:req" }, ctx)).toBe(true)
    })
})

describe("normalizeConnection", () => {
    it("flips a drag that started at an in-pin or landed on an out-pin", () => {
        const flipped = normalizeConnection({ source: "svc", target: "b", sourceHandle: "in:req", targetHandle: null })
        expect(flipped).toEqual({ source: "b", target: "svc", sourceHandle: null, targetHandle: "in:req" })
    })

    it("leaves a forward drag alone", () => {
        const forward = { source: "svc", target: "b", sourceHandle: "out:evt", targetHandle: null }
        expect(normalizeConnection(forward)).toBe(forward)
    })
})

describe("genEdgeId", () => {
    it("skips ids already in use", () => {
        expect(genEdgeId(new Set())).toBe("e0")
        expect(genEdgeId(new Set(["e0", "e1"]))).toBe("e2")
        expect(genEdgeId(new Set(["e0", "e2"]))).toBe("e3")
    })
})

describe("nextKind", () => {
    it("cycles the catalog order and wraps", () => {
        expect(nextKind("association")).toBe("dependency")
        expect(nextKind("composition")).toBe("call")
        expect(nextKind("event")).toBe("association")
    })

    it("keeps the note anchor out of the cycle — a note edge stays a note", () => {
        expect(nextKind("note")).toBe("note")
    })
})

describe("defaultEdgeKind", () => {
    it("infers event for channels and event pins, call for http/grpc out-pins, composition into datastores", () => {
        expect(defaultEdgeKind({ sourceKind: "class", targetKind: "channel" })).toBe("event")
        expect(defaultEdgeKind({ sourceKind: "io", targetKind: "class", sourceBinding: "event" })).toBe("event")
        expect(defaultEdgeKind({ sourceKind: "io", targetKind: "external", sourceBinding: "grpc" })).toBe("call")
        expect(defaultEdgeKind({ sourceKind: "io", targetKind: "db" })).toBe("composition")
        expect(defaultEdgeKind({ sourceKind: "class", targetKind: "class" })).toBe("association")
    })
})

describe("applyConnect", () => {
    const edges = seedEdges(spec.edges)

    it("appends a persistent-id holo edge with the inferred kind", () => {
        const next = applyConnect(edges, { source: "a", target: "chan" }, ctx)
        expect(next).toHaveLength(2)
        const drawn = next[1]
        expect(drawn?.type).toBe("holo")
        expect(drawn?.id).toBe("e1")
        expect(drawn?.data).toEqual({ kind: "event", label: undefined, autoId: false })
    })

    it("keeps port handles, strips side anchors, and normalizes backwards drags", () => {
        const next = applyConnect(
            edges,
            { source: "b", target: "svc", sourceHandle: "a-top", targetHandle: "out:pay" },
            ctx
        )
        const drawn = next[1]
        expect(drawn?.source).toBe("svc")
        expect(drawn?.sourceHandle).toBe("out:pay")
        expect(drawn?.target).toBe("b")
        expect(drawn?.targetHandle).toBeUndefined()
        expect(drawn?.data?.kind).toBe("call")
    })

    it("returns the edges unchanged for an unusable connection", () => {
        expect(applyConnect(edges, { source: null, target: "b" }, ctx)).toEqual(edges)
    })
})
