/**
 * coerce.ts — scalar option coercers for the holo diagram command file.
 *
 * Mirrors planner's `coerce.ts` integer coercer (kept local, not imported across
 * the app boundary): an arity-1 option carrying `coerce: integer` runs this only
 * when a value is present, so an absent knob stays `undefined`. A non-integer
 * token raises so cmdore surfaces exit 2.
 */

import type { CoerceContext } from "cmdore"

/** Parse an exact base-10 integer (optional sign, all digits); throw → cmdore exit 2. */
export const integer = (value: string, { label }: CoerceContext): number => {
    if (!/^[+-]?\d+$/.test(value.trim())) {
        throw new Error(`${label} must be an integer, got '${value}'.`)
    }
    return Number.parseInt(value, 10)
}
