/**
 * visuals.ts — the pure edge-kind → visual mapping the edge registry hangs off.
 *
 * Every `EdgeKind` maps to a line treatment (dash + colour token) and at most
 * one marker per end. The direction convention (schema.ts): `source` is the
 * parent / owner / whole / caller, so the four STRUCTURAL kinds wear their
 * marker at the source end (triangle at the parent, diamond at the owner) and
 * the four FLOW kinds at the target end (arrow at the thing used / called /
 * notified). Marker geometry lives in MarkerDefs.jsx; colours resolve through
 * the CSS vars in ../theme/tokens.css, so this module stays DOM-free and
 * bun-testable.
 */

import type { z } from "zod"
import type { EdgeKind } from "../kinds/schema"

export type EdgeKindName = z.output<typeof EdgeKind>

/** The marker vocabulary (DOM ids get the `holo-mk-` prefix via `markerUrl`). */
export const MARKER_IDS = ["tri", "open", "dia-hollow", "dia-filled", "arr-sync", "arr-async"] as const
export type MarkerId = (typeof MARKER_IDS)[number]

/** The colour role of an edge: neutral UML line, sync call, or async event. */
export type EdgeColor = "line" | "sync" | "async"

export type EdgeVisual = {
    dashed: boolean
    color: EdgeColor
    markerStart?: MarkerId
    markerEnd?: MarkerId
}

/** kind → visual. `Record` keeps the mapping total — a new kind fails the build until it lands here. */
export const EDGE_VISUALS: Record<EdgeKindName, EdgeVisual> = {
    inheritance: { dashed: false, color: "line", markerStart: "tri" },
    realization: { dashed: true, color: "line", markerStart: "tri" },
    aggregation: { dashed: false, color: "line", markerStart: "dia-hollow" },
    composition: { dashed: false, color: "line", markerStart: "dia-filled" },
    association: { dashed: false, color: "line", markerEnd: "open" },
    dependency: { dashed: true, color: "line", markerEnd: "open" },
    call: { dashed: false, color: "sync", markerEnd: "arr-sync" },
    event: { dashed: true, color: "async", markerEnd: "arr-async" }
}

/** The CSS var an edge colour role resolves through (tokens.css). */
export const EDGE_COLOR_VARS: Record<EdgeColor, string> = {
    line: "var(--edge-line, #7a7e85)",
    sync: "var(--sync, #6aa3d5)",
    async: "var(--async, #4db6ac)"
}

/** The `url(#…)` reference for a marker id, matching the DOM ids MarkerDefs.jsx mounts. */
export const markerUrl = (id: MarkerId): string => `url(#holo-mk-${id})`
