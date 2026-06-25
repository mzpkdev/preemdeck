/**
 * coerce.ts — scalar option coercers for the wire command files.
 *
 * Mirrors dock's `core/coercers.ts` integer coercer: an arity-1 option carrying
 * `coerce: integer` runs this only when a value is present, so an absent knob
 * stays `undefined` (the cmdore "unset" signal the flag>env>default resolvers in
 * knobs.ts key on). A non-integer token raises so cmdore surfaces exit 2.
 */

import type { CoerceContext } from "cmdore"

/** Parse an exact base-10 integer (optional sign, all digits); throw → cmdore exit 2. */
export const integer = (value: string, { label }: CoerceContext): number => {
    if (!/^[+-]?\d+$/.test(value.trim())) {
        throw new Error(`${label} must be an integer, got '${value}'.`)
    }
    return Number.parseInt(value, 10)
}
