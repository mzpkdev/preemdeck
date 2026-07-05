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

/** Minimal valid node per kind — the union's one-of-each corpus. */
const KIND_MINIMALS = [
    { id: "n1", kind: "class", name: "C" },
    { id: "n2", kind: "enum", name: "E" },
    { id: "n3", kind: "fn", name: "f(): void" },
    { id: "n4", kind: "db", name: "DB" },
    { id: "n5", kind: "actor", name: "User" },
    { id: "n6", kind: "external", name: "Stripe" },
    { id: "n7", kind: "channel", name: "orders" }
]

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
        expect(NodeSpec.safeParse({ id: "x", kind: "blob", name: "X" }).success).toBe(false)
    })

    it("parses a minimal node of every kind", () => {
        for (const node of KIND_MINIMALS) {
            const result = NodeSpec.safeParse(node)
            expect(result.success).toBe(true)
        }
    })

    it("normalizes the kind-specific fields: enum values default, db engine and channel transport stay optional", () => {
        const en = NodeSpec.parse({ id: "e", kind: "enum", name: "Kind" })
        expect(en.kind === "enum" && en.values).toEqual([])
        const db = NodeSpec.parse({ id: "d", kind: "db", name: "OrderDB", engine: "postgres" })
        expect(db.kind === "db" && db.engine).toBe("postgres")
        const chan = NodeSpec.parse({ id: "c", kind: "channel", name: "OrderCreated", transport: "ws" })
        expect(chan.kind === "channel" && chan.transport).toBe("ws")
        const bare = NodeSpec.parse({ id: "c2", kind: "channel", name: "orders" })
        expect(bare.kind === "channel" && bare.transport).toBeUndefined()
    })

    it("accepts free-form stereotypes and the shared base fields", () => {
        const parsed = ClassNodeSpec.parse({
            id: "reg",
            kind: "class",
            name: "Registry",
            stereotype: "singleton",
            border: "distinct",
            group: "core"
        })
        expect(parsed.stereotype).toBe("singleton")
        expect(parsed.border).toBe("distinct")
        expect(parsed.group).toBe("core")
        // No defaults materialize for the optional base fields.
        const bare = ClassNodeSpec.parse({ id: "c", kind: "class", name: "C" })
        expect("border" in bare && bare.border !== undefined).toBe(false)
        expect("group" in bare && bare.group !== undefined).toBe(false)
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

    it("parses the flow edge kinds with label and port anchors", () => {
        const result = GraphSpec.parse({
            nodes: [
                { id: "a", kind: "io", name: "A", outputs: [{ id: "out1", label: "Created", binding: "event" }] },
                { id: "b", kind: "io", name: "B", inputs: [{ id: "in1", label: "orders" }] }
            ],
            edges: [
                { source: "a", target: "b", kind: "call", label: "HTTP" },
                { source: "a", target: "b", kind: "event", sourcePort: "out1", targetPort: "in1" }
            ]
        })
        expect(result.edges[0]?.label).toBe("HTTP")
        expect(result.edges[1]?.kind).toBe("event")
        expect(result.edges[1]?.sourcePort).toBe("out1")
        expect(result.edges[1]?.targetPort).toBe("in1")
    })

    it("validates edge ports against declared io pin ids", () => {
        const doc = {
            nodes: [
                {
                    id: "svc",
                    kind: "io",
                    name: "Svc",
                    inputs: [{ id: "req", label: "POST /x", binding: "http" }],
                    outputs: [{ id: "evt", label: "Created", binding: "event" }, { label: "anonymous pin" }]
                },
                { id: "c", kind: "class", name: "C" }
            ],
            edges: [{ id: "ok", source: "svc", target: "c", kind: "event", sourcePort: "evt" }]
        }
        expect(GraphSpec.safeParse(doc).success).toBe(true)

        const badPort = GraphSpec.safeParse({
            ...doc,
            edges: [{ id: "bad", source: "svc", target: "c", sourcePort: "nope" }]
        })
        expect(badPort.success).toBe(false)
        if (!badPort.success) {
            expect(badPort.error.issues[0]?.message).toContain(`sourcePort "nope" is not a declared output pin id`)
        }

        // A targetPort must name an INPUT pin on the TARGET node (an io node).
        const wrongEnd = GraphSpec.safeParse({
            ...doc,
            edges: [{ id: "wrong", source: "c", target: "svc", targetPort: "evt" }]
        })
        expect(wrongEnd.success).toBe(false)
    })

    it("validates group membership: must name a group node, acyclically", () => {
        const ok = GraphSpec.safeParse({
            nodes: [
                { id: "core", kind: "group", name: "Core" },
                { id: "svc", kind: "io", name: "Svc", group: "core" }
            ]
        })
        expect(ok.success).toBe(true)

        const notAGroup = GraphSpec.safeParse({
            nodes: [
                { id: "c", kind: "class", name: "C" },
                { id: "svc", kind: "io", name: "Svc", group: "c" }
            ]
        })
        expect(notAGroup.success).toBe(false)

        const dangling = GraphSpec.safeParse({
            nodes: [{ id: "svc", kind: "io", name: "Svc", group: "ghost" }]
        })
        expect(dangling.success).toBe(false)

        const cycle = GraphSpec.safeParse({
            nodes: [
                { id: "a", kind: "group", name: "A", group: "b" },
                { id: "b", kind: "group", name: "B", group: "a" }
            ]
        })
        expect(cycle.success).toBe(false)
        if (!cycle.success) {
            expect(cycle.error.issues.some((issue) => issue.message.includes("cycle"))).toBe(true)
        }
    })

    it("parses graph-level layout hints", () => {
        const parsed = GraphSpec.parse({ nodes: [], layout: { direction: "RIGHT", spacing: 40 } })
        expect(parsed.layout?.direction).toBe("RIGHT")
        expect(parsed.layout?.spacing).toBe(40)
        expect(GraphSpec.parse({ nodes: [] }).layout).toBeUndefined()
        expect(GraphSpec.safeParse({ nodes: [], layout: { direction: "SIDEWAYS" } }).success).toBe(false)
    })

    it("fails loud when an edge endpoint names a missing node", () => {
        const result = GraphSpec.safeParse({
            nodes: [{ id: "a", kind: "class", name: "A" }],
            edges: [{ id: "bad", source: "a", target: "ghost" }]
        })
        expect(result.success).toBe(false)
        if (!result.success) {
            expect(result.error.issues[0]?.message).toContain(`target "ghost" is not a node id`)
            expect(result.error.issues[0]?.path).toEqual(["edges", 0, "target"])
        }
    })
})
