/**
 * pyname.test.ts — pin pyName() to the reference `PurePosixPath(value).name`, the
 * anti-traversal guard for inject_mode/show_mode. The expected column was
 * captured from the interpreter, so any drift in the guard is caught here.
 */

import { describe, expect, test } from "bun:test"
import { pyName } from "./pyname.ts"

describe("pyName matches the reference PurePosixPath(value).name", () => {
    // [input, expected] — verified against the reference.
    const cases: Array<[string, string]> = [
        ["..", ".."],
        [".", ""],
        ["../secret", "secret"],
        ["a/b", "b"],
        ["swarm", "swarm"],
        ["", ""],
        ["  ", "  "],
        ["./x", "x"],
        ["a/", "a"],
        ["/etc", "etc"],
        ["a/..", ".."],
        ["...", "..."],
        ["/", ""],
        ["//", ""],
        ["a/./b", "b"],
        ["foo..bar", "foo..bar"],
        [".hidden", ".hidden"]
    ]
    for (const [input, expected] of cases) {
        test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
            expect(pyName(input)).toBe(expected)
        })
    }

    test("the guard (name !== value) rejects every traversal-shaped value", () => {
        for (const bad of ["../secret", "a/b", "./x", "a/", "/etc", "a/..", "/", "//", "a/./b", "."]) {
            expect(pyName(bad) !== bad).toBe(true)
        }
        for (const ok of ["swarm", "ask", "auto", "foo..bar", ".hidden", "..."]) {
            expect(pyName(ok) === ok).toBe(true)
        }
    })
})
