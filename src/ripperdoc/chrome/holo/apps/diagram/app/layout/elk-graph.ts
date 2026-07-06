/**
 * elk-graph.ts — pure builders for the ELK layout pass.
 *
 * DiagramCanvas owns the elk instance and the async `elk.layout()` call; this
 * module owns everything deterministic around it: layout options (with the
 * spec's optional hints folded in), the ELK graph built from MEASURED React
 * Flow nodes — nested when groups are present — and applying the returned
 * coordinates back onto the flow nodes.
 *
 * Hierarchy rules (the sharp edges live here, pinned by the spec file):
 * - A group node passes NO width/height to ELK — the compound size is derived
 *   from its children plus padding (extra top headroom for the label tab). Its
 *   pass-1 measured size is the label tab, and feeding that in would fix the
 *   frame at nonsense dimensions.
 * - The root carries `hierarchyHandling: INCLUDE_CHILDREN` so edges crossing a
 *   boundary layer globally, and every edge is attached to the LOWEST COMMON
 *   ANCESTOR container of its endpoints (ELK's documented requirement).
 * - ELK returns child coordinates RELATIVE to their parent — exactly React
 *   Flow's `parentId` semantics, so positions map 1:1; compound nodes
 *   additionally get their computed width/height written back (React Flow
 *   does not auto-size parents).
 */

/** The layout hints the spec may carry (schema.ts `LayoutHints`). */
export type LayoutHintsIn = {
    direction?: "DOWN" | "UP" | "RIGHT" | "LEFT"
    spacing?: number
}

/** ELK layered layout knobs; hints override direction/spacing (layer gap keeps today's 60→80 ratio). */
export const buildLayoutOptions = (hints: LayoutHintsIn = {}): Record<string, string> => {
    const spacing = hints.spacing ?? 60
    return {
        "elk.algorithm": "layered",
        "elk.direction": hints.direction ?? "DOWN",
        "elk.layered.spacing.nodeNodeBetweenLayers": String(Math.round((spacing * 4) / 3)),
        "elk.spacing.nodeNode": String(spacing)
    }
}

/** Compound padding: room for children plus the group's label tab up top. */
const GROUP_PADDING = "[top=28,left=16,bottom=16,right=16]"

/** Used only if a node somehow reports no measured size (it always should by pass 2). */
export const FALLBACK = { width: 180, height: 80 }

/** The slice of a React Flow node the builder reads (`node.measured` appears after mount; `type` is the kind). */
export type MeasuredNode = {
    id: string
    type?: string
    parentId?: string
    measured?: { width?: number; height?: number }
}

export type EdgeEndpoints = { id: string; source: string; target: string }

export type ElkChild = {
    id: string
    width?: number
    height?: number
    layoutOptions?: Record<string, string>
    children?: ElkChild[]
    edges?: Array<{ id: string; sources: string[]; targets: string[] }>
}

export type ElkGraph = ElkChild & { layoutOptions: Record<string, string> }

/**
 * Build the (possibly nested) ELK input graph from measured nodes + edge
 * endpoints. Nodes with children become compounds (no size, padding);
 * leaves carry their measured size. Each edge lands in its endpoints' lowest
 * common ancestor container.
 */
export const buildElkGraph = (
    nodes: readonly MeasuredNode[],
    edges: readonly EdgeEndpoints[],
    hints: LayoutHintsIn = {}
): ElkGraph => {
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const childrenOf = new Map<string, MeasuredNode[]>()
    for (const n of nodes) {
        if (n.parentId === undefined) continue
        const siblings = childrenOf.get(n.parentId) ?? []
        siblings.push(n)
        childrenOf.set(n.parentId, siblings)
    }

    const build = (n: MeasuredNode): ElkChild => {
        const kids = childrenOf.get(n.id)
        if (kids !== undefined && kids.length > 0) {
            return { id: n.id, layoutOptions: { "elk.padding": GROUP_PADDING }, children: kids.map(build), edges: [] }
        }
        return {
            id: n.id,
            width: n.measured?.width ?? FALLBACK.width,
            height: n.measured?.height ?? FALLBACK.height,
            // Notes ride ELK's comment handling: the layered algorithm keeps a
            // comment box beside the node its (note) edge ties it to instead of
            // slotting it into a layer of its own.
            ...(n.type === "note" ? { layoutOptions: { "org.eclipse.elk.commentBox": "true" } } : {})
        }
    }

    const root: ElkGraph = {
        id: "root",
        layoutOptions: { ...buildLayoutOptions(hints), "elk.hierarchyHandling": "INCLUDE_CHILDREN" },
        children: nodes.filter((n) => n.parentId === undefined).map(build),
        edges: []
    }

    // Container lookup: every compound's elk node, so LCA placement can reach it.
    const containers = new Map<string, ElkChild>([["root", root]])
    const index = (child: ElkChild) => {
        if (child.children !== undefined) {
            containers.set(child.id, child)
            for (const c of child.children) index(c)
        }
    }
    for (const c of root.children ?? []) index(c)

    /** Proper-ancestor chain of a node id, nearest first. */
    const chainOf = (id: string): string[] => {
        const chain: string[] = []
        let cursor = byId.get(id)?.parentId
        while (cursor !== undefined) {
            chain.push(cursor)
            cursor = byId.get(cursor)?.parentId
        }
        return chain
    }

    for (const e of edges) {
        const targetAncestors = new Set(chainOf(e.target))
        const lca = chainOf(e.source).find((anc) => targetAncestors.has(anc))
        const container = (lca !== undefined ? containers.get(lca) : undefined) ?? root
        container.edges?.push({ id: e.id, sources: [e.source], targets: [e.target] })
    }

    return root
}

/** What `elk.layout()` resolves to, as far as we read it. */
export type LaidNode = { id: string; x?: number; y?: number; width?: number; height?: number; children?: LaidNode[] }
export type LaidGraph = { children?: LaidNode[] }

/**
 * Apply pass-2 results: each node gets ELK's position — RELATIVE to its
 * parent, which is exactly what React Flow expects of `parentId` children —
 * and is revealed; compounds additionally get ELK's computed width/height.
 * Node objects are cloned; their `data` is NOT touched, which the emission
 * guard in spec-sync.ts relies on.
 */
export const applyElkPositions = <
    N extends { id: string; position: { x: number; y: number }; style?: object; width?: number; height?: number }
>(
    laid: LaidGraph,
    nodes: readonly N[]
): N[] => {
    const info = new Map<string, LaidNode>()
    const walk = (children: LaidNode[] | undefined) => {
        for (const c of children ?? []) {
            info.set(c.id, c)
            walk(c.children)
        }
    }
    walk(laid.children)
    return nodes.map((n) => {
        const c = info.get(n.id)
        if (c === undefined) return { ...n, style: { ...n.style, opacity: 1 } }
        const compound = c.children !== undefined && c.children.length > 0
        return {
            ...n,
            position: { x: c.x ?? 0, y: c.y ?? 0 },
            ...(compound ? { width: c.width, height: c.height } : {}),
            style: { ...n.style, opacity: 1 }
        }
    })
}
