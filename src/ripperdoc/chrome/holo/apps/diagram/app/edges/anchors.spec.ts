/**
 * anchors.spec.ts — the floating-anchor math.
 *
 * Pins border-point projection (anchors leave the facing side), side
 * classification, parallel-pair separation (including opposite-direction
 * pairs sharing one group), and the pin-row anchor's border snapping.
 */

import { describe, expect, it } from "bun:test"
import { borderPoint, floatingAnchors, parallelShift, pinAnchor, sideOf } from "./anchors"

// Two 100×50 boxes: `right` sits 200px to the right of `left`, same row.
const left = { x: 0, y: 0, width: 100, height: 50 }
const right = { x: 300, y: 0, width: 100, height: 50 }
// And one directly below `left`.
const below = { x: 0, y: 200, width: 100, height: 50 }

describe("borderPoint / sideOf", () => {
    it("leaves through the facing side, horizontally", () => {
        const p = borderPoint(left, right)
        expect(p.x).toBe(100)
        expect(p.y).toBe(25)
        expect(sideOf(left, p)).toBe("right")
        const q = borderPoint(right, left)
        expect(q.x).toBe(300)
        expect(sideOf(right, q)).toBe("left")
    })

    it("leaves through the facing side, vertically", () => {
        const p = borderPoint(left, below)
        expect(p.y).toBe(50)
        expect(sideOf(left, p)).toBe("bottom")
        expect(sideOf(below, borderPoint(below, left))).toBe("top")
    })
})

describe("floatingAnchors", () => {
    it("returns both ends with sides, unshifted by default", () => {
        const { source, target } = floatingAnchors(left, right)
        expect(source.side).toBe("right")
        expect(target.side).toBe("left")
        expect(source.y).toBe(target.y)
    })

    it("applies a perpendicular shift to both ends", () => {
        const { source, target } = floatingAnchors(left, right, 10)
        // Perpendicular to a horizontal line is vertical.
        expect(source.y).toBe(25 + 10)
        expect(target.y).toBe(25 + 10)
        expect(source.side).toBe("right")
    })
})

describe("parallelShift", () => {
    const edges = [
        { id: "down", source: "app", target: "list" },
        { id: "up", source: "list", target: "app" },
        { id: "other", source: "app", target: "store" }
    ]

    it("is zero for a lone edge", () => {
        expect(parallelShift("other", "app", "store", edges)).toBe(0)
    })

    it("spreads a props-down/callback-up pair around the centre line", () => {
        const down = parallelShift("down", "app", "list", edges)
        const up = parallelShift("up", "list", "app", edges)
        expect(down).toBe(-7)
        expect(up).toBe(7)
    })
})

describe("pinAnchor", () => {
    const node = { x: 100, y: 100, width: 190, height: 80 }

    it("snaps to the border facing the counterpart, y locked to the pin row", () => {
        expect(pinAnchor(node, 130, 500)).toEqual({ x: 290, y: 130, side: "right" })
        expect(pinAnchor(node, 130, 0)).toEqual({ x: 100, y: 130, side: "left" })
    })
})
