/**
 * lib/text.ts — text helpers byte-compatible with the Python originals.
 *
 *   htmlEscape — matches `html.escape(s)` (quote=True, the stdlib default), used
 *                before handing text to the IDE notifier.
 *   parseUrl   — wraps WHATWG `new URL()` to preserve `urllib.parse.urlsplit`'s
 *                forgiving "no host -> return the input" behavior (the open-url
 *                validation + preview `_title_for`), instead of throwing.
 */

/**
 * Escape `&`, `<`, `>`, `"`, `'` exactly as Python's `html.escape(s, quote=True)`.
 * `&` is replaced first so the entities it introduces aren't double-escaped.
 *
 *   &  -> &amp;
 *   <  -> &lt;
 *   >  -> &gt;
 *   "  -> &quot;
 *   '  -> &#x27;
 */
export const htmlEscape = (s: string): string =>
    s
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#x27;")

/**
 * The fields lifted from a parsed URL, mirroring the subset of
 * `urllib.parse.urlsplit` that the open_url/preview callers read. `hostname` is
 * `null` (not "") for host-less input so callers can branch on the urlsplit-style
 * fallback; `raw` carries the untouched input for that no-host label.
 */
export type ParsedUrl = {
    /** The lowercased scheme WITHOUT a trailing colon, e.g. "https" — "" when absent. */
    scheme: string
    /** Lowercased hostname, or null when the input parsed without a host. */
    hostname: string | null
    /** Numeric port, or null when none was given. */
    port: number | null
    /** The original input, unchanged. Use this as the no-host fallback label. */
    raw: string
}

/**
 * Parse `url` the forgiving way `urlsplit` does: never throws. WHATWG `new URL`
 * requires a host (and rejects bare `localhost:3000`, treating the part before
 * `:` as the protocol), so this returns `{hostname: null}` for host-less inputs,
 * leaving callers to fall back to `raw` — matching Python `_title_for`'s
 * `if parts.hostname: ... else: return url`.
 *
 * Validation callers (open-url) should check `scheme` is "http"/"https".
 */
export const parseUrl = (url: string): ParsedUrl => {
    try {
        const u = new URL(url)
        return {
            // u.protocol is "https:"; strip the trailing colon to match urlsplit.scheme.
            scheme: u.protocol.replace(/:$/, "").toLowerCase(),
            hostname: u.hostname ? u.hostname.toLowerCase() : null,
            port: u.port ? Number(u.port) : null,
            raw: url
        }
    } catch {
        return { scheme: "", hostname: null, port: null, raw: url }
    }
}
