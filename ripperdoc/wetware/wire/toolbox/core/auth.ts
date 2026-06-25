/**
 * auth.ts — the one-status-401 credential gate. Port of
 * server/src/wire/auth.py.
 *
 * Every gated endpoint rejects a missing, wrong, or unknown credential with HTTP
 * 401; the body names the failed key and carries a machine-readable `code`. The
 * credentials ride QUERY params (`secret` / `token`), read RAW here (never as a
 * validated zod param) so a MISSING one still reaches this code and 401s — never
 * the framework's auto-422 for a required param. That one-status-401 contract is
 * the whole point of reading them by hand.
 *
 * `requireSecret` / `requireToken` are middleware: they 401 (by throwing
 * {@link WireAuthError}, caught by the app's error handler) or fall through to
 * the route. `/shard` is the lone exception — its 401 body is markdown, so it
 * checks the secret inline rather than through `requireSecret` (see app.ts).
 */

import type { Context, MiddlewareHandler } from "hono"
import type { Room } from "./room.ts"

/** The machine-readable failure code on a {@link WireAuthError}. */
export type WireAuthCode = "invalid_secret" | "invalid_token"

/**
 * A 401 carrying a machine-readable `code` beside the prose `detail`.
 *
 * Mirrors Python's `WireAuthError(HTTPException)`: `status` is always 401, and
 * the registered error handler renders `{detail, code}`. A peer branches on
 * `code` without parsing the prose.
 */
export class WireAuthError extends Error {
    readonly status = 401 as const
    readonly code: WireAuthCode
    readonly detail: string

    constructor(code: WireAuthCode, detail: string) {
        super(detail)
        this.name = "WireAuthError"
        this.code = code
        this.detail = detail
    }
}

/**
 * Gate on the `secret` query param. Missing or wrong -> throws
 * {@link WireAuthError} `invalid_secret`; otherwise calls `next`.
 *
 * Bound to a concrete `secret` at app-build time so the middleware closes over
 * config without reading app state. Used by /jackin and /spectate. (/shard
 * checks the secret itself because its bodies are markdown, not JSON.)
 */
export const requireSecret = (secret: string): MiddlewareHandler => {
    return async (c, next) => {
        const provided = c.req.query("secret")
        if (provided === undefined || provided !== secret) {
            throw new WireAuthError("invalid_secret", "invalid secret")
        }
        await next()
    }
}

/**
 * Gate on the `token` query param via the room's verdict. VALID falls through;
 * UNKNOWN or missing -> throws {@link WireAuthError} `invalid_token`.
 *
 * Tokens are IMMORTAL — once minted a token stays VALID for the room's life;
 * neither jackout nor an idle drop kills it (they only drop the peer from the
 * roster, and the next call rejoins). So unknown / missing is the only 401 here.
 * Used by /recv, /send, /jackout. Runs BEFORE the route body, so a bogus token
 * 401s instantly and /recv never parks for it.
 */
export const requireToken = (room: Room): MiddlewareHandler => {
    return async (c, next) => {
        const token = c.req.query("token")
        if (token === undefined || room.status(token) !== "valid") {
            throw new WireAuthError("invalid_token", "invalid token")
        }
        await next()
    }
}

/** Render a {@link WireAuthError} as a 401 JSON body `{detail, code}`. */
export const renderAuthError = (c: Context, err: WireAuthError): Response => {
    return c.json({ detail: err.detail, code: err.code }, 401)
}
