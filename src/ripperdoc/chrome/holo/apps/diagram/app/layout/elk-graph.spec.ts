/**
 * elk-graph.spec.ts — the pure half of the ELK layout pass.
 *
 * Pins the graph shape fed to `elk.layout()` (measured sizes with a fallback,
 * edge endpoint mapping, the layered/DOWN options) and the application of the
 * returned coordinates (reposition + reveal, node `data` untouched by
 * reference — the emission guard depends on that).
 */

import { describe, expect, it } from "bun:test"
import { applyElkPositions, buildElkGraph, buildLayoutOptions, FALLBACK } from "./elk-graph"

describe("buildLayoutOptions", () => {
    it("keeps the layered top-down defaults", () => {
        const options = buildLayoutOptions()
        expect(options["elk.algorithm"]).toBe("layered")
        expect(options["elk.direction"]).toBe("DOWN")
        expect(options["elk.spacing.nodeNode"]).toBe("60")
        expect(options["elk.layered.spacing.nodeNodeBetweenLayers"]).toBe("80")
    })

    it("folds hints in, preserving the 4/3 layer-gap ratio", () => {
        const options = buildLayoutOptions({ direction: "RIGHT", spacing: 45 })
        expect(options["elk.direction"]).toBe("RIGHT")
        expect(options["elk.spacing.nodeNode"]).toBe("45")
        expect(options["elk.layered.spacing.nodeNodeBetweenLayers"]).toBe("60")
    })
})

describe("buildElkGraph", () => {
    it("feeds measured sizes through and falls back when a node has none", () => {
        const graph = buildElkGraph(
            [{ id: "a", measured: { width: 200, height: 120 } }, { id: "b" }],
            [{ id: "e0", source: "a", target: "b" }]
        )
        expect(graph.children).toEqual([
            { id: "a", width: 200, height: 120 },
            { id: "b", width: FALLBACK.width, height: FALLBACK.height }
        ])
        expect(graph.edges).toEqual([{ id: "e0", sources: ["a"], targets: ["b"] }])
        expect(graph.layoutOptions["elk.algorithm"]).toBe("layered")
    })

    it("marks note-typed leaves as ELK comment boxes; other leaves stay bare", () => {
        const graph = buildElkGraph(
            [
                { id: "owner", type: "fn", measured: { width: 180, height: 40 } },
                { id: "memo", type: "note", measured: { width: 200, height: 60 } }
            ],
            [{ id: "tie", source: "memo", target: "owner" }]
        )
        const memo = graph.children?.find((c) => c.id === "memo")
        const owner = graph.children?.find((c) => c.id === "owner")
        expect(memo?.layoutOptions).toEqual({ "org.eclipse.elk.commentBox": "true" })
        expect(owner?.layoutOptions).toBeUndefined()
    })
})

describe("buildElkGraph with groups", () => {
    // A boundary with two members, one node outside, one nested boundary.
    const nodes = [
        { id: "core", measured: { width: 120, height: 20 } }, // a group's own measurement is its label tab — ignored
        { id: "svc", parentId: "core", measured: { width: 190, height: 100 } },
        { id: "db", parentId: "core", measured: { width: 120, height: 66 } },
        { id: "inner", parentId: "core" },
        { id: "leaf", parentId: "inner", measured: { width: 50, height: 40 } },
        { id: "gateway", measured: { width: 180, height: 60 } }
    ]
    const edges = [
        { id: "cross", source: "gateway", target: "svc" },
        { id: "local", source: "svc", target: "db" },
        { id: "deep", source: "svc", target: "leaf" }
    ]
    const graph = buildElkGraph(nodes, edges, { direction: "RIGHT" })

    it("nests children under their group, root carries INCLUDE_CHILDREN + hints", () => {
        expect(graph.layoutOptions["elk.hierarchyHandling"]).toBe("INCLUDE_CHILDREN")
        expect(graph.layoutOptions["elk.direction"]).toBe("RIGHT")
        expect(graph.children?.map((c) => c.id)).toEqual(["core", "gateway"])
        const core = graph.children?.find((c) => c.id === "core")
        expect(core?.children?.map((c) => c.id)).toEqual(["svc", "db", "inner"])
    })

    it("gives compounds padding and NO size; leaves keep measured sizes", () => {
        const core = graph.children?.find((c) => c.id === "core")
        expect(core?.width).toBeUndefined()
        expect(core?.height).toBeUndefined()
        expect(core?.layoutOptions?.["elk.padding"]).toContain("top=28")
        const svc = core?.children?.find((c) => c.id === "svc")
        expect(svc?.width).toBe(190)
        const inner = core?.children?.find((c) => c.id === "inner")
        expect(inner?.children?.map((c) => c.id)).toEqual(["leaf"])
        expect(inner?.width).toBeUndefined()
    })

    it("places each edge at its endpoints' lowest common ancestor container", () => {
        expect(graph.edges?.map((e) => e.id)).toEqual(["cross"])
        const core = graph.children?.find((c) => c.id === "core")
        expect(core?.edges?.map((e) => e.id)).toEqual(["local", "deep"])
    })
})

describe("applyElkPositions", () => {
    const data = { name: "A" }
    const nodes = [
        { id: "a", position: { x: 0, y: 0 }, style: { opacity: 0 }, data },
        { id: "b", position: { x: 7, y: 7 }, style: { opacity: 0 }, data }
    ]

    it("repositions from ELK's answer and reveals", () => {
        const laid = { children: [{ id: "a", x: 10, y: 20 }] }
        const applied = applyElkPositions(laid, nodes)
        expect(applied[0]?.position).toEqual({ x: 10, y: 20 })
        expect(applied[0]?.style).toEqual({ opacity: 1 })
    })

    it("keeps a node's own position when ELK omits it, and never touches data", () => {
        const applied = applyElkPositions({ children: [{ id: "a", x: 1, y: 2 }] }, nodes)
        expect(applied[1]?.position).toEqual({ x: 7, y: 7 })
        expect(applied[0]?.data).toBe(data)
        expect(applied[1]?.data).toBe(data)
    })

    it("defaults missing elk coordinates to 0", () => {
        const applied = applyElkPositions({ children: [{ id: "a" }] }, nodes.slice(0, 1))
        expect(applied[0]?.position).toEqual({ x: 0, y: 0 })
    })

    it("walks nested results: parent-relative child positions, computed compound sizes", () => {
        const laid = {
            children: [
                {
                    id: "core",
                    x: 40,
                    y: 40,
                    width: 400,
                    height: 250,
                    children: [{ id: "svc", x: 16, y: 28 }]
                }
            ]
        }
        type FixtureNode = {
            id: string
            position: { x: number; y: number }
            style: { opacity: number }
            data: typeof data
            width?: number
            height?: number
        }
        const flowNodes: FixtureNode[] = [
            { id: "core", position: { x: 0, y: 0 }, style: { opacity: 0 }, data },
            { id: "svc", position: { x: 0, y: 0 }, style: { opacity: 0 }, data }
        ]
        const applied = applyElkPositions(laid, flowNodes)
        expect(applied[0]?.position).toEqual({ x: 40, y: 40 })
        expect(applied[0]?.width).toBe(400)
        expect(applied[0]?.height).toBe(250)
        // Child stays parent-relative — exactly React Flow's parentId semantics.
        expect(applied[1]?.position).toEqual({ x: 16, y: 28 })
        expect(applied[1]?.width).toBeUndefined()
    })
})
