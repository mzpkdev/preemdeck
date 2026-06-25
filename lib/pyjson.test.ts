/**
 * pyjson.test.ts — pin pyJsonString/injectionEnvelope to the reference default
 * json.dumps (ensure_ascii=True, ", "/": " separators). Expected values captured
 * from the reference; these guard the byte-parity of every injection hook.
 */

import { describe, expect, test } from "bun:test"
import { injectionEnvelope, pyJsonString } from "./pyjson.ts"

describe("pyJsonString matches the reference json.dumps(s)", () => {
    // [input, expected json.dumps output] — captured from the reference.
    const cases: Array<[string, string]> = [
        ["a\tb\nc\r", '"a\\tb\\nc\\r"'],
        ['q"q', '"q\\"q"'],
        ["back\\slash", '"back\\\\slash"'],
        ["em — dash", '"em \\u2014 dash"'],
        ["ast \u{1f600} ral", '"ast \\ud83d\\ude00 ral"'],
        ["a/b", '"a/b"'], // slash is NOT escaped
        ["", '""'],
        [" ", '" "'],
        ["naïve", '"na\\u00efve"'],
        ["\b\f", '"\\b\\f"'],
        ["\x00\x01\x1f", '"\\u0000\\u0001\\u001f"'],
        ["\x7f", '"\\u007f"'], // DEL is escaped (> 0x7e)
        ["~", '"~"'] // 0x7e printable, raw
    ]
    for (const [input, expected] of cases) {
        test(`${JSON.stringify(input)}`, () => {
            expect(pyJsonString(input)).toBe(expected)
        })
    }
})

describe("injectionEnvelope", () => {
    test("matches the reference json.dumps envelope shape (spaced separators)", () => {
        expect(injectionEnvelope("UserPromptSubmit", "hello — world")).toBe(
            '{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "hello \\u2014 world"}}'
        )
    })
})
