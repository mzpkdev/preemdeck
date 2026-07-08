/**
 * escape-mdx.spec.ts — escapeStrayMdx neutralizes the MDX-hostile tokens that
 * blank MDXEditor (bare `<tag>`/`{expr}` in prose), while leaving code, directives,
 * frontmatter, and autolinks untouched, and never double-escaping a saved plan.
 */

import { describe, expect, it } from "bun:test"
import { escapeStrayMdx } from "./escape-mdx"

describe("escapeStrayMdx", () => {
    it("escapes a bare <tag> in prose so MDX does not read it as JSX", () => {
        expect(escapeStrayMdx('shows "by <name>" here')).toBe('shows "by \\<name>" here')
    })

    it("escapes a bare {expr} in prose", () => {
        expect(escapeStrayMdx("returns {name, avatarUrl} to the caller")).toBe(
            "returns \\{name, avatarUrl} to the caller"
        )
    })

    it("leaves < and { inside a fenced code block untouched", () => {
        const md = ["```ts", "const x: Record<string, string> = {}", "```"].join("\n")
        expect(escapeStrayMdx(md)).toBe(md)
    })

    it("leaves < and { inside an inline code span untouched", () => {
        const md = "the type `Record<string, {a: 1}>` is fine"
        expect(escapeStrayMdx(md)).toBe(md)
    })

    it("leaves ::: container-directive lines untouched", () => {
        const md = ':::details{summary="Implementation · 7 files"}'
        expect(escapeStrayMdx(md)).toBe(md)
    })

    it("leaves YAML frontmatter untouched but escapes the body", () => {
        const md = ["---", "title: <keep me>", "---", "body <escape me>"].join("\n")
        const expected = ["---", "title: <keep me>", "---", "body \\<escape me>"].join("\n")
        expect(escapeStrayMdx(md)).toBe(expected)
    })

    it("preserves CommonMark autolinks", () => {
        expect(escapeStrayMdx("see <https://example.com> now")).toBe("see <https://example.com> now")
    })

    it("is idempotent: an already-escaped plan is not double-escaped", () => {
        const once = escapeStrayMdx("by <name> and {x}")
        expect(escapeStrayMdx(once)).toBe(once)
    })

    it("escapes several occurrences on one line", () => {
        expect(escapeStrayMdx("<a> then <b> then {c}")).toBe("\\<a> then \\<b> then \\{c}")
    })
})
