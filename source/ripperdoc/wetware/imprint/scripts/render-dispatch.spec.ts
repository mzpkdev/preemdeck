/**
 * render-dispatch.spec.ts — golden tests for the JOBS panel renderer.
 * Panels are compared as verbatim strings (the whole point of a golden test for a
 * fixed-shape renderer): any rail/glyph/gauge drift is caught. Error cases assert
 * parse() throws DispatchError (the CLI exits nonzero with a stderr message).
 */

import { describe, expect, it } from "bun:test"
import { DispatchError, parse, render } from "./render-dispatch.ts"

const context = describe

const panel = (argv: string[]): string => {
    return render(parse(argv))
}

describe("render-dispatch", () => {
    context("rendering golden panels", () => {
        it.each([
            [
                "1 — golden anchor",
                [
                    "--done",
                    "Task 1 - Scout",
                    "--running",
                    "Task 2,Task 3",
                    "Task 4,Task 5",
                    "--pending",
                    "Task 7 - Lint"
                ],
                "JOBS  ▰▱▱▱▱▱  1/6\n" +
                    "├── ■ Task 1 - Scout\n" +
                    "├── ⎇\n" +
                    "│   ├── ▣ Task 2\n" +
                    "│   └── ▣ Task 3\n" +
                    "├── ⎇\n" +
                    "│   ├── ▣ Task 4\n" +
                    "│   └── ▣ Task 5\n" +
                    "└── □ Task 7 - Lint"
            ],
            ["2 — a lone atomic job collapses to a one-branch tree", ["--running", "solo"], "JOBS  ▱  0/1\n└── ▣ solo"],
            [
                "3 — sequential mix of every plain status, order preserved",
                ["--done", "a", "--running", "b", "--pending", "c", "--failed", "d"],
                "JOBS  ▰▱▱▱  1/4\n├── ■ a\n├── ▣ b\n├── □ c\n└── ⊞ d"
            ],
            [
                "4 — interleaved repeated flags keep left-to-right order",
                ["--done", "A", "--running", "B", "--done", "C"],
                "JOBS  ▰▰▱  2/3\n├── ■ A\n├── ▣ B\n└── ■ C"
            ],
            [
                "5 — a single running wave nests under a bare ⎇ node",
                ["--running", "p,q,r"],
                "JOBS  ▱▱▱  0/3\n└── ⎇\n    ├── ▣ p\n    ├── ▣ q\n    └── ▣ r"
            ],
            [
                "6 — a pending wave uses the queued glyph □",
                ["--pending", "lint,types"],
                "JOBS  ▱▱  0/2\n└── ⎇\n    ├── □ lint\n    └── □ types"
            ],
            [
                "7 — multiple waves plus a trailing singleton",
                ["--running", "a,b", "c,d", "tail"],
                "JOBS  ▱▱▱▱▱  0/5\n├── ⎇\n│   ├── ▣ a\n│   └── ▣ b\n├── ⎇\n│   ├── ▣ c\n│   └── ▣ d\n└── ▣ tail"
            ],
            [
                "8 — a wave that is NOT last continues on │",
                ["--running", "x,y", "--done", "z"],
                "JOBS  ▰▱▱  1/3\n├── ⎇\n│   ├── ▣ x\n│   └── ▣ y\n└── ■ z"
            ],
            [
                "9 — blocked job draws ⊟ and appends ` — waits on X`",
                ["--done", "scout", "--blocked", "verify", "--waits-on", "parallel"],
                "JOBS  ▰▱  1/2\n├── ■ scout\n└── ⊟ verify — waits on parallel"
            ],
            [
                "10 — tight comma separates → parallel wave",
                ["--running", "a,b"],
                "JOBS  ▱▱  0/2\n└── ⎇\n    ├── ▣ a\n    └── ▣ b"
            ],
            [
                "11 — the shell slip `a,` `b` → one wave",
                ["--running", "a,", "b"],
                "JOBS  ▱▱  0/2\n└── ⎇\n    ├── ▣ a\n    └── ▣ b"
            ],
            [
                "12 — a comma followed by a space is literal → one label",
                ["--running", "retry, then bail"],
                "JOBS  ▱  0/1\n└── ▣ retry, then bail"
            ],
            [
                "13 — each wave member counts, the parallel node does not",
                ["--done", "one", "two", "--running", "a,b,c"],
                "JOBS  ▰▰▱▱▱  2/5\n├── ■ one\n├── ■ two\n└── ⎇\n    ├── ▣ a\n    ├── ▣ b\n    └── ▣ c"
            ],
            [
                "14 — done/failed never form waves: commas there are literal",
                ["--done", "a,b"],
                "JOBS  ▰  1/1\n└── ■ a,b"
            ],
            ["15 — no jobs → idle panel, not an error", [], "JOBS  ▱  0/0\n└── idle"]
        ] as [string, string[], string][])("%s", (_label, argv, golden) => {
            expect(panel(argv)).toBe(golden)
        })
    })

    context("error cases — parse throws DispatchError", () => {
        it.each([
            ["16 — an unknown flag", ["--bogus", "x"]],
            ["17 — --waits-on with no preceding --blocked", ["--waits-on", "x"]],
            ["18 — --blocked with no following --waits-on", ["--blocked", "verify"]],
            ["19 — --waits-on with no value", ["--blocked", "verify", "--waits-on"]],
            ["20 — a status flag with no LABEL", ["--running"]]
        ] as [string, string[]][])("%s", (_label, argv) => {
            expect(() => parse(argv)).toThrow(DispatchError)
        })
    })
})
