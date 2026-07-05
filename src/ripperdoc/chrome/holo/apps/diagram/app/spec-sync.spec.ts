/**
 * spec-sync.spec.ts — the GraphSpec ⇄ React Flow conversion contract.
 *
 * Pins the seeding shape DiagramCanvas relies on (hidden-at-origin measure
 * pass, `type` = kind, spec objects riding into `data` BY REFERENCE), the
 * seed → project edge round-trip (what the emission writes back must be what
 * the author wrote), and the emission guards that keep layout/selection churn
 * from rewriting the plan file.
 */

import { describe, expect, it } from "bun:test"
import { GraphSpec } from "./kinds/schema"
import type { FlowNodeLike, GraphNode } from "./spec-sync"
import {
    changedSinceBaseline,
    edgesChangedSinceBaseline,
    projectEdges,
    reparentChildren,
    seedEdges,
    seedNodes,
    sourcePortHandle,
    targetPortHandle
} from "./spec-sync"

const spec = GraphSpec.parse({
    nodes: [
        { id: "a", kind: "io", name: "A", inputs: [{ id: "p2", label: "props" }] },
        { id: "b", kind: "io", name: "B", outputs: [{ id: "p1", label: "emit" }] }
    ],
    edges: [
        { id: "e-inherit", source: "a", target: "b", kind: "inheritance" },
        { source: "b", target: "a", kind: "call", label: "props down", sourcePort: "p1", targetPort: "p2" }
    ]
})

describe("seedNodes", () => {
    it("seeds every node hidden at the origin with type = kind", () => {
        const seeded = seedNodes(spec.nodes)
        expect(seeded).toHaveLength(2)
        for (const node of seeded) {
            expect(node.type).toBe("io")
            expect(node.position).toEqual({ x: 0, y: 0 })
            expect(node.style).toEqual({ opacity: 0 })
        }
    })

    it("carries the spec node into data by reference", () => {
        const seeded = seedNodes(spec.nodes)
        expect(seeded[0]?.data).toBe(spec.nodes[0])
        expect(seeded[1]?.data).toBe(spec.nodes[1])
    })

    it("sorts parents before children and maps group membership to parentId + extent", () => {
        const grouped = GraphSpec.parse({
            nodes: [
                { id: "svc", kind: "io", name: "Svc", group: "core" },
                { id: "inner", kind: "group", name: "Inner", group: "core" },
                { id: "leaf", kind: "db", name: "Leaf", group: "inner" },
                { id: "core", kind: "group", name: "Core" }
            ]
        })
        const seeded = seedNodes(grouped.nodes)
        const order = seeded.map((n) => n.id)
        // Every parent precedes its children; non-members keep relative order.
        expect(order.indexOf("core")).toBeLessThan(order.indexOf("svc"))
        expect(order.indexOf("core")).toBeLessThan(order.indexOf("inner"))
        expect(order.indexOf("inner")).toBeLessThan(order.indexOf("leaf"))
        const svc = seeded.find((n) => n.id === "svc")
        expect(svc?.parentId).toBe("core")
        expect(svc?.extent).toBe("parent")
        const core = seeded.find((n) => n.id === "core")
        expect(core?.parentId).toBeUndefined()
    })
})

describe("reparentChildren", () => {
    // root ← outer(20,30) ← inner(5,7) ← leaf(3,4); sibling stays put.
    const dataOf = (id: string, group?: string): GraphNode => ({ id, kind: "db", name: id, group })
    const nodes: FlowNodeLike[] = [
        { id: "outer", position: { x: 20, y: 30 }, data: dataOf("outer") },
        { id: "inner", parentId: "outer", extent: "parent", position: { x: 5, y: 7 }, data: dataOf("inner", "outer") },
        { id: "leaf", parentId: "inner", extent: "parent", position: { x: 3, y: 4 }, data: dataOf("leaf", "inner") },
        { id: "solo", position: { x: 1, y: 1 }, data: dataOf("solo") }
    ]

    it("climbs past every doomed frame, folding offsets into the position", () => {
        const next = reparentChildren(nodes, new Set(["outer", "inner"]))
        const leaf = next.find((n) => n.id === "leaf")
        expect(leaf?.parentId).toBeUndefined()
        expect(leaf?.extent).toBeUndefined()
        expect(leaf?.position).toEqual({ x: 3 + 5 + 20, y: 4 + 7 + 30 })
        // Membership is spec: data must be a NEW object with group rewritten.
        expect(leaf?.data).not.toBe(nodes[2]?.data)
        expect(leaf?.data.group).toBeUndefined()
        // Untouched nodes keep their exact objects (no spurious emission).
        expect(next.find((n) => n.id === "solo")).toBe(nodes[3])
    })

    it("stops at the nearest surviving ancestor", () => {
        const next = reparentChildren(nodes, new Set(["inner"]))
        const leaf = next.find((n) => n.id === "leaf")
        expect(leaf?.parentId).toBe("outer")
        expect(leaf?.extent).toBe("parent")
        expect(leaf?.position).toEqual({ x: 8, y: 11 })
        expect(leaf?.data.group).toBe("outer")
    })
})

describe("seedEdges", () => {
    const seeded = seedEdges(spec.edges)

    it("seeds the holo edge type with kind + label riding in data", () => {
        expect(seeded[0]?.type).toBe("holo")
        expect(seeded[0]?.data).toEqual({ kind: "inheritance", label: undefined, autoId: false })
        expect(seeded[1]?.data).toEqual({ kind: "call", label: "props down", autoId: true })
    })

    it("keeps declared ids and synthesizes positional ones (marked autoId)", () => {
        expect(seeded[0]?.id).toBe("e-inherit")
        expect(seeded[1]?.id).toBe("e1")
    })

    it("maps declared ports onto prefixed handle ids", () => {
        expect(seeded[0]?.sourceHandle).toBeUndefined()
        expect(seeded[1]?.sourceHandle).toBe(sourcePortHandle("p1"))
        expect(seeded[1]?.targetHandle).toBe(targetPortHandle("p2"))
    })
})

describe("projectEdges", () => {
    it("round-trips seeded edges back to the author's spec edges", () => {
        const projected = projectEdges(seedEdges(spec.edges))
        expect(projected).toEqual(spec.edges)
        // The synthesized id must NOT leak into the written spec.
        expect(projected[1]?.id).toBeUndefined()
    })

    it("drops non-port handles (side-anchor drawing affordances)", () => {
        const projected = projectEdges([
            { id: "x", source: "a", target: "b", sourceHandle: "a-top", targetHandle: null }
        ])
        expect(projected[0]?.sourcePort).toBeUndefined()
        expect(projected[0]?.targetPort).toBeUndefined()
        expect(projected[0]?.kind).toBe("association")
    })
})

describe("changedSinceBaseline", () => {
    const baseline = spec.nodes

    it("is quiet while every element is reference-identical", () => {
        expect(changedSinceBaseline([...baseline], baseline)).toBe(false)
    })

    it("trips when an element is replaced (an inline edit)", () => {
        const edited = [baseline[0], { ...(baseline[1] as object) }]
        expect(changedSinceBaseline(edited, baseline)).toBe(true)
    })

    it("trips on length changes (add/remove)", () => {
        expect(changedSinceBaseline(baseline.slice(0, 1), baseline)).toBe(true)
        expect(changedSinceBaseline([...baseline, {}], baseline)).toBe(true)
    })
})

describe("edgesChangedSinceBaseline", () => {
    const baseline = seedEdges(spec.edges)

    it("ignores selection-style clones (same endpoints/handles, same data ref)", () => {
        const selected = baseline.map((e) => ({ ...e, selected: true }))
        expect(edgesChangedSinceBaseline(selected, baseline)).toBe(false)
    })

    it("normalizes null and undefined handles as equal", () => {
        const clones = baseline.map((e) => ({
            ...e,
            sourceHandle: e.sourceHandle ?? null,
            targetHandle: e.targetHandle ?? null
        }))
        expect(edgesChangedSinceBaseline(clones, baseline)).toBe(false)
    })

    it("trips on retype/relabel (new data ref), retarget, create and delete", () => {
        const first = baseline[0]
        if (!first) throw new Error("fixture edge missing")
        const retyped = [{ ...first, data: { ...first.data } }, ...baseline.slice(1)]
        expect(edgesChangedSinceBaseline(retyped, baseline)).toBe(true)
        const retargeted = [{ ...first, target: "a" }, ...baseline.slice(1)]
        expect(edgesChangedSinceBaseline(retargeted, baseline)).toBe(true)
        expect(edgesChangedSinceBaseline(baseline.slice(0, 1), baseline)).toBe(true)
        expect(edgesChangedSinceBaseline([...baseline, first], baseline)).toBe(true)
    })
})
