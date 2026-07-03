/**
 * schema.ts — zod contracts for the diagram graph spec.
 *
 * Members are STRUCTURED, not preformatted strings: the renderer reads
 * `{vis, name, type}` attributes and `{vis, name, params, type}` methods off the
 * parsed node and lays the UML compartments out itself (so it can colour the
 * visibility glyph, italicise abstract names, etc.). `NodeSpec` is a
 * `discriminatedUnion` on `kind` seeded with `class` only — `class` + a
 * `stereotype` already covers class / abstract / interface / enumeration
 * visually, so a later slice extends the union (and the kind registry) rather
 * than this one carrying interface/enum kinds. `EdgeSpec.kind` is carried
 * through for the future edge/marker registry but unused for now.
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

/** A UML class box; `stereotype` drives abstract/interface/enumeration rendering. */
export const ClassNodeSpec = z.object({
    id: z.string(),
    kind: z.literal("class"),
    name: z.string(),
    stereotype: z.enum(["abstract", "interface", "enumeration"]).optional(),
    attributes: z.array(Attribute).default([]),
    methods: z.array(Method).default([])
})

/** The node union, discriminated on `kind`; extend with more kinds later. */
export const NodeSpec = z.discriminatedUnion("kind", [ClassNodeSpec])

/** A directed edge; `kind` is carried for the future edge/marker registry (unused now). */
export const EdgeSpec = z.object({
    id: z.string().optional(),
    source: z.string(),
    target: z.string(),
    kind: z
        .enum(["association", "dependency", "inheritance", "realization", "aggregation", "composition"])
        .default("association")
})

/** The whole graph document: the agent authors it, serve.ts serves it, the page renders it. */
export const GraphSpec = z.object({
    nodes: z.array(NodeSpec),
    edges: z.array(EdgeSpec).default([])
})

/** Parsed (output) shape of a class node — what the `ClassNode` component receives as `data`. */
export type ClassNodeData = z.infer<typeof ClassNodeSpec>
