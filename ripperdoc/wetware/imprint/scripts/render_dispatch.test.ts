/**
 * render_dispatch.test.ts — golden tests ported from test_render_dispatch.py.
 * Panels are compared as verbatim strings (the whole point of a golden test for a
 * fixed-shape renderer): any rail/glyph/gauge drift is caught. Error cases assert
 * parse() throws DispatchError (the .py exits nonzero with a stderr message).
 */

import { describe, expect, test } from "bun:test";
import { DispatchError, parse, render } from "./render_dispatch.ts";

function panel(argv: string[]): string {
  return render(parse(argv));
}

describe("render_dispatch golden panels", () => {
  test("1 — golden anchor", () => {
    expect(
      panel(["--done", "Task 1 - Scout", "--running", "Task 2,Task 3", "Task 4,Task 5", "--pending", "Task 7 - Lint"]),
    ).toBe(
      "JOBS  ▰▱▱▱▱▱  1/6\n" +
        "├── ■ Task 1 - Scout\n" +
        "├── ⎇\n" +
        "│   ├── ▣ Task 2\n" +
        "│   └── ▣ Task 3\n" +
        "├── ⎇\n" +
        "│   ├── ▣ Task 4\n" +
        "│   └── ▣ Task 5\n" +
        "└── □ Task 7 - Lint",
    );
  });

  test("2 — a lone atomic job collapses to a one-branch tree", () => {
    expect(panel(["--running", "solo"])).toBe("JOBS  ▱  0/1\n└── ▣ solo");
  });

  test("3 — sequential mix of every plain status, order preserved", () => {
    expect(panel(["--done", "a", "--running", "b", "--pending", "c", "--failed", "d"])).toBe(
      "JOBS  ▰▱▱▱  1/4\n├── ■ a\n├── ▣ b\n├── □ c\n└── ⊞ d",
    );
  });

  test("4 — interleaved repeated flags keep left-to-right order", () => {
    expect(panel(["--done", "A", "--running", "B", "--done", "C"])).toBe("JOBS  ▰▰▱  2/3\n├── ■ A\n├── ▣ B\n└── ■ C");
  });

  test("5 — a single running wave nests under a bare ⎇ node", () => {
    expect(panel(["--running", "p,q,r"])).toBe("JOBS  ▱▱▱  0/3\n└── ⎇\n    ├── ▣ p\n    ├── ▣ q\n    └── ▣ r");
  });

  test("6 — a pending wave uses the queued glyph □", () => {
    expect(panel(["--pending", "lint,types"])).toBe("JOBS  ▱▱  0/2\n└── ⎇\n    ├── □ lint\n    └── □ types");
  });

  test("7 — multiple waves plus a trailing singleton", () => {
    expect(panel(["--running", "a,b", "c,d", "tail"])).toBe(
      "JOBS  ▱▱▱▱▱  0/5\n├── ⎇\n│   ├── ▣ a\n│   └── ▣ b\n├── ⎇\n│   ├── ▣ c\n│   └── ▣ d\n└── ▣ tail",
    );
  });

  test("8 — a wave that is NOT last continues on │", () => {
    expect(panel(["--running", "x,y", "--done", "z"])).toBe("JOBS  ▰▱▱  1/3\n├── ⎇\n│   ├── ▣ x\n│   └── ▣ y\n└── ■ z");
  });

  test("9 — blocked job draws ⊟ and appends ` — waits on X`", () => {
    expect(panel(["--done", "scout", "--blocked", "verify", "--waits-on", "parallel"])).toBe(
      "JOBS  ▰▱  1/2\n├── ■ scout\n└── ⊟ verify — waits on parallel",
    );
  });

  test("10 — tight comma separates → parallel wave", () => {
    expect(panel(["--running", "a,b"])).toBe("JOBS  ▱▱  0/2\n└── ⎇\n    ├── ▣ a\n    └── ▣ b");
  });

  test("11 — the shell slip `a,` `b` → one wave", () => {
    expect(panel(["--running", "a,", "b"])).toBe("JOBS  ▱▱  0/2\n└── ⎇\n    ├── ▣ a\n    └── ▣ b");
  });

  test("12 — a comma followed by a space is literal → one label", () => {
    expect(panel(["--running", "retry, then bail"])).toBe("JOBS  ▱  0/1\n└── ▣ retry, then bail");
  });

  test("13 — each wave member counts, the parallel node does not", () => {
    expect(panel(["--done", "one", "two", "--running", "a,b,c"])).toBe(
      "JOBS  ▰▰▱▱▱  2/5\n├── ■ one\n├── ■ two\n└── ⎇\n    ├── ▣ a\n    ├── ▣ b\n    └── ▣ c",
    );
  });

  test("14 — done/failed never form waves: commas there are literal", () => {
    expect(panel(["--done", "a,b"])).toBe("JOBS  ▰  1/1\n└── ■ a,b");
  });

  test("15 — no jobs → idle panel, not an error", () => {
    expect(panel([])).toBe("JOBS  ▱  0/0\n└── idle");
  });
});

describe("render_dispatch error cases (parse throws DispatchError)", () => {
  test("16 — an unknown flag", () => {
    expect(() => parse(["--bogus", "x"])).toThrow(DispatchError);
  });
  test("17 — --waits-on with no preceding --blocked", () => {
    expect(() => parse(["--waits-on", "x"])).toThrow(DispatchError);
  });
  test("18 — --blocked with no following --waits-on", () => {
    expect(() => parse(["--blocked", "verify"])).toThrow(DispatchError);
  });
  test("19 — --waits-on with no value", () => {
    expect(() => parse(["--blocked", "verify", "--waits-on"])).toThrow(DispatchError);
  });
  test("20 — a status flag with no LABEL", () => {
    expect(() => parse(["--running"])).toThrow(DispatchError);
  });
});
