import type { CoerceContext } from "cmdore"

export const integer = (value: string, { label }: CoerceContext): number => {
    if (!/^[+-]?\d+$/.test(value.trim())) {
        throw new Error(`${label} must be an integer, got '${value}'.`)
    }
    return Number.parseInt(value, 10)
}
