/**
 * lib/text.test.ts — htmlEscape parity with the reference html.escape, and parseUrl's
 * forgiving urlsplit-style fallback. Pure functions: no mocks needed (the
 * simplest case — assert input/output directly).
 */

import { describe, expect, test } from "bun:test"
import { htmlEscape, parseUrl } from "./text.ts"

describe("htmlEscape", () => {
    test("escapes the five html.escape(quote=True) characters", () => {
        // Golden value produced by the reference: html.escape('<a href="x">&\'</a>')
        expect(htmlEscape('<a href="x">&\'</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#x27;&lt;/a&gt;")
    })

    test("ampersand is escaped first, so entities are not double-escaped", () => {
        expect(htmlEscape("a & b")).toBe("a &amp; b")
        expect(htmlEscape("<")).toBe("&lt;") // not &amp;lt;
    })

    test("leaves plain text untouched", () => {
        expect(htmlEscape("Claude finished responding")).toBe("Claude finished responding")
    })
})

describe("parseUrl", () => {
    test("parses scheme/hostname/port from a full http URL", () => {
        const p = parseUrl("http://localhost:3000/x?y=1")
        expect(p.scheme).toBe("http")
        expect(p.hostname).toBe("localhost")
        expect(p.port).toBe(3000)
    })

    test("https with default port -> port null", () => {
        const p = parseUrl("https://example.com")
        expect(p.scheme).toBe("https")
        expect(p.hostname).toBe("example.com")
        expect(p.port).toBeNull()
    })

    test("host-less input does not throw; hostname null, raw preserved (urlsplit fallback)", () => {
        // `_title_for` falls back to the raw string when there's no hostname.
        const p = parseUrl("not a url")
        expect(p.hostname).toBeNull()
        expect(p.raw).toBe("not a url")
    })

    test("non-http scheme is reported so validators can reject it", () => {
        const p = parseUrl("ftp://host/file")
        expect(p.scheme).toBe("ftp")
        expect(["http", "https"]).not.toContain(p.scheme)
    })
})
