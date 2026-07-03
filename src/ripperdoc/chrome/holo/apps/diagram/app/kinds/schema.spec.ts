/**
 * schema.spec.ts — the graph spec's zod contract.
 *
 * Covers the normalization the renderer leans on: a class node parses, member
 * `vis` defaults to `+`, `attributes`/`methods` default to `[]`, an unknown
 * `kind` is rejected by the discriminated union, and `GraphSpec` parses a
 * `{nodes, edges}` doc (defaulting `edges` to `[]`).
 */

import { describe, expect, it } from "bun:test"
import { Attribute, ClassNodeSpec, GraphSpec, Method, NodeSpec } from "./schema"

describe("schema", () => {
    it("parses a valid class node", () => {
        const parsed = ClassNodeSpec.parse({ id: "shape", kind: "class", name: "Shape", stereotype: "abstract" })
        expect(parsed.kind).toBe("class")
        expect(parsed.name).toBe("Shape")
        expect(parsed.stereotype).toBe("abstract")
    })

    it("defaults member visibility to +", () => {
        expect(Attribute.parse({ name: "radius", type: "number" }).vis).toBe("+")
        expect(Method.parse({ name: "area", type: "number" }).vis).toBe("+")
    })

    it("defaults attributes and methods to []", () => {
        const parsed = ClassNodeSpec.parse({ id: "c", kind: "class", name: "C" })
        expect(parsed.attributes).toEqual([])
        expect(parsed.methods).toEqual([])
    })

    it("rejects an unknown node kind", () => {
        expect(NodeSpec.safeParse({ id: "x", kind: "actor", name: "X" }).success).toBe(false)
    })

    it("parses a {nodes, edges} document and defaults an edge kind to association", () => {
        const result = GraphSpec.parse({
            nodes: [{ id: "a", kind: "class", name: "A" }],
            edges: [{ source: "a", target: "a" }]
        })
        expect(result.nodes).toHaveLength(1)
        expect(result.edges[0]?.kind).toBe("association")
    })

    it("defaults edges to [] when the doc omits them", () => {
        expect(GraphSpec.parse({ nodes: [] }).edges).toEqual([])
    })
})
