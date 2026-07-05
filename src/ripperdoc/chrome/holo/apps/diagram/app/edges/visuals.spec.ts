/**
 * visuals.spec.ts — the edge registry's visual contract.
 *
 * Pins the marker-side convention (source = parent/owner ⇒ structural kinds
 * mark the START, flow kinds the END), the dash/colour table, and that every
 * marker an edge references exists in the marker vocabulary MarkerDefs mounts.
 */

import { describe, expect, it } from "bun:test"
import { EdgeKind } from "../kinds/schema"
import { EDGE_COLOR_VARS, EDGE_VISUALS, MARKER_IDS, markerUrl } from "./visuals"

describe("EDGE_VISUALS", () => {
    it("covers every EdgeKind with exactly one marker on exactly one end", () => {
        for (const kind of EdgeKind.options) {
            const visual = EDGE_VISUALS[kind]
            expect(visual).toBeDefined()
            const markers = [visual.markerStart, visual.markerEnd].filter(Boolean)
            expect(markers).toHaveLength(1)
        }
    })

    it("marks structural kinds at the source (parent/owner) and flow kinds at the target", () => {
        for (const kind of ["inheritance", "realization", "aggregation", "composition"] as const) {
            expect(EDGE_VISUALS[kind].markerStart).toBeDefined()
            expect(EDGE_VISUALS[kind].markerEnd).toBeUndefined()
        }
        for (const kind of ["association", "dependency", "call", "event"] as const) {
            expect(EDGE_VISUALS[kind].markerEnd).toBeDefined()
            expect(EDGE_VISUALS[kind].markerStart).toBeUndefined()
        }
    })

    it("keeps the catalog's line treatments: dashed realization/dependency/event, coloured call/event", () => {
        expect(EDGE_VISUALS.realization.dashed).toBe(true)
        expect(EDGE_VISUALS.dependency.dashed).toBe(true)
        expect(EDGE_VISUALS.event.dashed).toBe(true)
        expect(EDGE_VISUALS.inheritance.dashed).toBe(false)
        expect(EDGE_VISUALS.call.color).toBe("sync")
        expect(EDGE_VISUALS.event.color).toBe("async")
        expect(EDGE_VISUALS.association.color).toBe("line")
    })

    it("references only markers in the mounted vocabulary, with resolvable colour vars", () => {
        for (const visual of Object.values(EDGE_VISUALS)) {
            for (const marker of [visual.markerStart, visual.markerEnd]) {
                if (marker) expect(MARKER_IDS).toContain(marker)
            }
            expect(EDGE_COLOR_VARS[visual.color]).toMatch(/^var\(--/)
        }
    })
})

describe("markerUrl", () => {
    it("prefixes the DOM id namespace", () => {
        expect(markerUrl("tri")).toBe("url(#holo-mk-tri)")
        expect(markerUrl("dia-filled")).toBe("url(#holo-mk-dia-filled)")
    })
})
