/**
 * escape-mdx.ts — make an arbitrary markdown plan safe to load into MDXEditor.
 *
 * MDXEditor parses its input as MDX, where a bare `<tag>` or `{expr}` in prose is
 * JSX / a JS expression. An invalid or unclosed one (the write:plan template even
 * seeds `<placeholder>` tokens as literal text) makes the parser fail, and the
 * editor renders a blank page. Plans are prose, not components, so escape the
 * stray `<` / `{` so they render literally.
 *
 * Skipped, because the characters are structural there: YAML frontmatter, fenced
 * code (``` / ~~~), `:::`/`:name` directive lines, inline code spans, and
 * CommonMark autolinks (`<https://…>`, `<a@b>`). Idempotent — an already
 * backslash-escaped char is left alone, so re-loading a saved plan never
 * double-escapes.
 */

const FENCE = /^\s*(```+|~~~+)/
const FRONTMATTER_RULE = /^---\s*$/
const CONTAINER_DIRECTIVE = /^\s*:::/
const LEAF_DIRECTIVE = /^\s*:[A-Za-z][\w-]*[[{]/
const URI_AUTOLINK = /^<[A-Za-z][\w+.-]*:[^\s>]*>/
const EMAIL_AUTOLINK = /^<[^\s@>]+@[^\s>]+>/

/** Escape stray `<`/`{` in one prose line, copying inline-code spans and autolinks verbatim. */
function escapeProseLine(line: string): string {
    let result = ""
    let i = 0
    while (i < line.length) {
        const ch = line[i]
        if (ch === "`") {
            const run = line.slice(i).match(/^`+/)?.[0] ?? "`"
            const close = line.indexOf(run, i + run.length)
            if (close === -1) {
                // Unterminated inline code: copy the remainder verbatim.
                return result + line.slice(i)
            }
            result += line.slice(i, close + run.length)
            i = close + run.length
            continue
        }
        if ((ch === "<" || ch === "{") && line[i - 1] !== "\\") {
            const rest = line.slice(i)
            if (ch === "<" && (URI_AUTOLINK.test(rest) || EMAIL_AUTOLINK.test(rest))) {
                result += ch
                i += 1
                continue
            }
            result += `\\${ch}`
            i += 1
            continue
        }
        result += ch
        i += 1
    }
    return result
}

/** Escape stray MDX-significant characters so an arbitrary markdown plan loads into MDXEditor without a parse error. */
export function escapeStrayMdx(markdown: string): string {
    let inFence = false
    let fenceChar = ""
    let inFrontmatter = false

    return markdown
        .split("\n")
        .map((line, index) => {
            if (index === 0 && FRONTMATTER_RULE.test(line)) {
                inFrontmatter = true
                return line
            }
            if (inFrontmatter) {
                if (FRONTMATTER_RULE.test(line)) {
                    inFrontmatter = false
                }
                return line
            }

            const fence = line.match(FENCE)
            if (fence) {
                const marker = fence[1]?.[0] ?? ""
                if (!inFence) {
                    inFence = true
                    fenceChar = marker
                } else if (marker === fenceChar) {
                    inFence = false
                    fenceChar = ""
                }
                return line
            }
            if (inFence) {
                return line
            }

            if (CONTAINER_DIRECTIVE.test(line) || LEAF_DIRECTIVE.test(line)) {
                return line
            }

            return escapeProseLine(line)
        })
        .join("\n")
}
