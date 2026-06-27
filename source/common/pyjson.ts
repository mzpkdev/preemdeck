/**
 * lib/pyjson.ts — a faithful reproduction of the reference default `json.dumps(...)`
 * framing for the context-injection envelope.
 *
 * WHY THIS EXISTS (and not lib/hook.ts's serializer): the reference injectors all
 * emit the envelope with a BARE `json.dumps({...})`, i.e. the reference defaults:
 *   - separators ", " and ": " (a space after each comma and colon), and
 *   - ensure_ascii=True (every non-ASCII char escaped to \uXXXX, astral chars as
 *     UTF-16 surrogate pairs).
 * `JSON.stringify` differs on BOTH counts (compact separators, raw UTF-8), so the
 * envelope would NOT be byte-identical for any non-ASCII body or even the spacing.
 * lib/hook.ts's compact emitter is fine for its ASCII tests but is not byte-exact
 * against these injectors; we serialize here to match the reference exactly.
 *
 * Scope: just enough to render the fixed envelope shape (two nested objects, all
 * string keys/values). Verified against the reference json encoder.
 */

const SHORT_ESCAPES: Record<string, string> = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t"
}

/**
 * Serialize a string exactly like the reference `json.dumps(s)` with ensure_ascii=True:
 * wrap in double quotes; short-escape `" \ \b \f \n \r \t`; emit other control
 * chars (< 0x20) and every non-ASCII char (> 0x7e) as lowercase `\uXXXX` (astral
 * code units come through as surrogate-pair \uXXXX\uXXXX via charCodeAt). `/` is
 * NOT escaped. Matches the reference byte-for-byte.
 */
export const pyJsonString = (s: string): string => {
    let out = '"'
    for (let i = 0; i < s.length; i++) {
        const ch = s[i] as string
        const code = s.charCodeAt(i)
        const short = SHORT_ESCAPES[ch]
        if (short !== undefined) {
            out += short
        } else if (code < 0x20 || code > 0x7e) {
            out += `\\u${code.toString(16).padStart(4, "0")}`
        } else {
            out += ch
        }
    }
    return `${out}"`
}

/**
 * The injection envelope, byte-identical to the reference injectors'
 * `json.dumps({"hookSpecificOutput": {"hookEventName": e, "additionalContext": t}})`.
 */
export const injectionEnvelope = (eventName: string, additionalContext: string): string =>
    `{"hookSpecificOutput": {"hookEventName": ${pyJsonString(eventName)}, "additionalContext": ${pyJsonString(additionalContext)}}}`
