/**
 * app.ts — the Hono app factory and routes. Port of the original wire's app layer.
 *
 * {@link createApp} builds the app, constructs the one {@link Room}, wires the
 * eight endpoints, and hands back the room plus a {@link startReaper} the CLI
 * layer drives shutdown with. The HTTP layer is thin: it validates credentials,
 * calls the core, and renames the room's camelCase fields to the wire's
 * snake_case + `from` at the JSON boundary. OpenAPI is served at `/schema`.
 *
 * A custom doc post-process makes `/schema` honest — it marks the
 * `secret`/`token` query params required (they are NOT zod-validated params, so a
 * missing credential still returns 401, NOT a 422), attaches the raw-text /send
 * body, and surfaces the 401 error contract per gated route. Built once, cached.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import { streamSSE } from "hono/streaming"
import { renderAuthError, requireSecret, requireToken, WireAuthError } from "./auth.ts"
import type { Clock } from "./clock.ts"
import type { Config } from "./config.ts"
import { renderShard } from "./manual.ts"
import type { LogEntry, Room, SpectateRoster } from "./room.ts"
import { makeRoom } from "./room.ts"
import {
    type Action,
    HealthResponse,
    JackinResponse,
    JackoutResponse,
    MessageEvent,
    PresenceEvent,
    RecvResponse,
    SendResponse
} from "./schemas.ts"

/** The markdown body a wrong/missing-secret /shard returns (NOT JSON). */
const SHARD_401 = "You are not authorized to view this resource, your secret is invalid."

/**
 * Seconds a /spectate stream waits with no new events before a heartbeat frame.
 * A module constant (not a Config field) for v1. Mirrors recv's "empty but
 * alive" heartbeat: a roster + quiet_for snapshot so a quiet stream still reads
 * as a live, occupied room.
 */
const SPECTATE_HEARTBEAT_SECONDS = 15

/**
 * A /recv response schema for the OpenAPI doc ONLY.
 *
 * schemas.ts's `RecvResponse` discriminates `events` with `z.discriminatedUnion`,
 * which the underlying OpenAPI generator (@asteasolutions/zod-to-openapi) crashes
 * on — its `mapDiscriminator` chokes on `MessageEvent.type`'s `.default("message")`
 * wrapper. The wire JSON contract is unchanged (the runtime never zod-validates
 * the response — /recv hands back a plain object); this swaps ONLY the events
 * element from a discriminated union to a plain `z.union` so generation succeeds.
 * The three other fields are reused straight from the real schema, preserving
 * their exact descriptions; the events description is copied verbatim from
 * schemas.ts so /schema stays byte-honest.
 */
const RECV_EVENTS_DESC =
    "Events past your read-cursor you haven't seen yet, oldest first; empty on a heartbeat. An id-ordered " +
    "mix of chat (`type: message`) and presence (`type: action(join)` / `action(leave)`) — branch on " +
    "`type`. A message's own number lives in `message.seq`; the top-level `id` is the stream position. " +
    "Excludes events about you (your own messages and your own join/leave). The cursor advances only over " +
    "events actually delivered here. Empty `events` is not the end of the conversation — check " +
    "`present_peers` and `quiet_for`, then poll again."
const RecvResponseDoc = z
    .object({
        events: z.array(z.union([MessageEvent, PresenceEvent])).openapi({ description: RECV_EVENTS_DESC }),
        present_peers: RecvResponse.shape.present_peers,
        read_your_last_message: RecvResponse.shape.read_your_last_message,
        quiet_for: RecvResponse.shape.quiet_for
    })
    .openapi("RecvResponse")

/** The wire's JSON event shape — either a message or a presence event. */
type WireEvent = MessageEvent | PresenceEvent

/**
 * Render one room log entry to its wire JSON shape, per-type (no null-padding).
 *
 * The single serialization seam shared by /recv and /spectate, so a peer and a
 * spectator see byte-identical event JSON. A message emits
 * id/type/from/message{seq,body}/sent_at; a presence event id/type/peer/sent_at.
 * `sentAt` is already an ISO second-precision UTC `Z` string from the room — the
 * boundary just renames it to `sent_at` (and `sender` -> `from`).
 */
const eventToModel = (entry: LogEntry): WireEvent => {
    if (entry.type === "message") {
        return {
            id: entry.id,
            type: "message",
            from: entry.sender,
            message: { seq: entry.seq, body: entry.message },
            sent_at: entry.sentAt
        }
    }
    return { id: entry.id, type: entry.type, peer: entry.peer, sent_at: entry.sentAt }
}

/** A /spectate snapshot/heartbeat payload: the live roster + silence, no backlog. */
type SpectateRosterPayload = {
    readonly present_peers: string[]
    readonly quiet_for: number | null
}

/** Rename the room's {@link SpectateRoster} (camelCase) to its wire JSON shape. */
const rosterToModel = (roster: SpectateRoster): SpectateRosterPayload => ({
    present_peers: roster.presentPeers,
    quiet_for: roster.quietFor
})

/**
 * Maps a log entry's wire `type` to its short SSE `event:` name. The SSE event
 * name is message|join|leave; the data object's own `type` field keeps the full
 * string (message / action(join) / action(leave)) — they differ on purpose so a
 * client switches on the lightweight SSE event while the payload stays identical
 * to /recv.
 */
const SSE_EVENT_NAME: Record<LogEntry["type"], string> = {
    message: "message",
    "action(join)": "join",
    "action(leave)": "leave"
}

/**
 * Build one SSE frame, byte-identical to the original's `_sse_frame`: an optional
 * `id:` line FIRST, then `event:`, then `data:`, terminated by the blank line
 * that delimits SSE events. Written raw via `stream.write` rather than Hono's
 * `writeSSE` because that helper emits `event:`/`data:`/`id:` in a fixed order
 * (id LAST) — the wire contract puts `id:` first, so a reconnecting client and
 * the original framing stay identical. `data` is one already-serialized compact
 * JSON line (every payload is a single line, so each `data:` is one JSON.parse).
 */
const sseFrame = (event: string, data: string, eventId?: number): string => {
    const head = eventId === undefined ? "" : `id: ${eventId}\n`
    return `${head}event: ${event}\ndata: ${data}\n\n`
}

/**
 * Resolve a /spectate stream's start cursor (an event id).
 *
 * Honors the `Last-Event-ID` reconnect header: a valid non-negative int resumes
 * from there (events with id greater than it are replayed). Anything missing or
 * malformed falls back to the room's current max event id — LIVE-ONLY, no
 * backlog. Clamped to the current max so a bogus future id can't skip live
 * events.
 */
const spectateStartId = (room: Room, lastEventId: string | undefined): number => {
    const current = room.eventId
    if (lastEventId === undefined) {
        return current
    }
    const parsed = Number(lastEventId)
    if (!Number.isInteger(parsed) || parsed < 0) {
        return current
    }
    return Math.min(parsed, current)
}

/** Build the action affordances handed to a peer at /jackin. */
const jackinActions = (base: string, token: string): Action[] => [
    { description: "Send a message.", method: "POST", url: `${base}/send?token=${token}`, body: "<message>" },
    { description: "Read unread messages.", method: "GET", url: `${base}/recv?token=${token}`, body: null }
]

/** The resolved base URL a peer reads: operator-declared public_url wins, else the request base. */
const resolveBase = (config: Config, requestUrl: string): string => {
    if (config.publicUrl !== null) {
        return config.publicUrl
    }
    const url = new URL(requestUrl)
    return `${url.protocol}//${url.host}`
}

// -- /schema doc post-processing -----------------------------------------
// The original keeps secret/token OPTIONAL in the signatures (so a missing one
// 401s, not 422) but marks them required in the DOC only. These tables drive the
// same post-process here over the generated OpenAPI document.

/** A query-param doc object the generated doc lacks (creds are read raw, not via zod). */
type DocParam = { name: string; in: "query"; required?: boolean; description: string; schema: { type: string } }

const SECRET_PARAM = (): DocParam => ({
    name: "secret",
    in: "query",
    required: true,
    description: "The room secret, minted by the host. Required; a missing or invalid secret returns 401.",
    schema: { type: "string" }
})

const TOKEN_PARAM = (): DocParam => ({
    name: "token",
    in: "query",
    required: true,
    description:
        "Your peer token from /jackin. Required; missing or unknown returns 401 `invalid token`. The token is " +
        "immortal — it never expires; jacking out or going idle only drops you from the roster, and your next call " +
        "rejoins you.",
    schema: { type: "string" }
})

const WAIT_PARAM = (): DocParam => ({
    name: "wait",
    in: "query",
    required: false,
    description:
        "Seconds the poll holds before an empty heartbeat; default 30, max 60 (clamped server-side). Set your curl " +
        "--max-time to 65 once — comfortably above the 60s max hold — and tune only wait; a --max-time at or below the " +
        "hold aborts the poll client-side before the heartbeat. A real message still returns the instant it's sent, " +
        "whatever wait is.",
    schema: { type: "string" }
})

const NAME_PARAM = (): DocParam => ({
    name: "name",
    in: "query",
    required: false,
    description:
        "Optional: request your own room name. A number is always appended, so you get `<name>-<n>` (e.g. alice -> " +
        "alice-1); if it's taken the number increments from 1. The name is normalized first — trimmed, lowercased, " +
        "inner whitespace and underscores -> `-`, slugified to `[a-z0-9-]` (so `My Agent` -> `my-agent-1`), capped at " +
        "32 chars. Omit it and you get peer-1, peer-2, … — check you_are for your actual name.",
    schema: { type: "string" }
})

/** The 401 doc body for a secret-gated JSON route (/jackin, /spectate). */
const SECRET_401_DESC = 'Missing or wrong `secret` -> body `{"detail": "invalid secret", "code": "invalid_secret"}`.'
/** The 401 doc body for a token-gated route. Names invalid_token as the ONLY token failure. */
const TOKEN_401_DESC =
    'Missing or unknown `token` -> body `{"detail": "invalid token", "code": "invalid_token"}`. Tokens are ' +
    "immortal: once minted on /jackin a token stays valid for the room's life — neither jackout nor an idle drop " +
    "retires it (a later call just rejoins the peer), so `invalid_token` is the only token failure."
/** /shard's 401 doc body: markdown, with the code on the X-Wire-Error header. */
const SHARD_401_DESC =
    "Missing or wrong `secret` -> markdown body, with the machine-readable code on the `X-Wire-Error: " +
    "invalid_secret` response header."

/** The raw-text /send request body, attached to the doc by hand (no zod model drives it). */
const SEND_REQUEST_BODY = {
    required: true,
    description:
        "The message text, as a raw plain-text body (`curl --data-raw 'your message'`). To address one peer, tag " +
        "them inline as `@peer-N` (e.g. `@peer-2 ship it`); this is a plain-text convention only — the server does " +
        "not parse or route on it, every peer still receives the whole message.",
    content: { "text/plain": { schema: { type: "string" } } }
}

/** /shard's route description (hand-documented — a plain route the generator never saw). */
const SHARD_DESCRIPTION =
    "Returns the room's onboarding manual as markdown — how to jack in, talk, and leave. Gated by the `secret` " +
    "query param; a missing or wrong secret returns 401 with a markdown body and an `X-Wire-Error: invalid_secret` " +
    "header. Non-blocking."

/** /send's route description (hand-documented — a raw-text plain route). */
const SEND_DESCRIPTION =
    "Post a message to the room and get back `{id, seq, behind_by, present_peers}` — the event's stream-position " +
    "`id` and the message's own gap-free `seq` for the message you just sent, plus `behind_by` (how many unread " +
    "chat messages from OTHERS are waiting for you — read them before you reply) and `present_peers` (the live " +
    "roster). Sending does NOT advance your read cursor: those `behind_by` messages stay unread and your next " +
    "/recv still delivers them. The body is raw plain text (`curl --data-raw 'your message'`), not JSON. Address " +
    "one peer by tagging `@peer-N` inline — a plain-text convention the server does not route on; every peer still " +
    "receives it. Gated by `token`. Non-blocking."

/**
 * The 200 success bodies for the three hand-documented plain routes (the
 * generator never saw them, so it emitted no success response). `/send` returns
 * JSON shaped by `SendResponse` (registered as a component below, so this is a
 * `$ref`); `/shard` returns markdown; `/spectate` an SSE stream. The
 * `Successful Response` summary mirrors the original's autogen default.
 */
const SEND_200 = {
    description: "Successful Response",
    content: { "application/json": { schema: { $ref: "#/components/schemas/SendResponse" } } }
}
const SHARD_200 = {
    description: "Successful Response",
    content: { "text/markdown": { schema: { type: "string" } } }
}
const SPECTATE_200 = {
    description: "Successful Response",
    content: { "text/event-stream": { schema: { type: "string" } } }
}

/** /spectate's route description (hand-documented — an SSE plain route). */
const SPECTATE_DESCRIPTION =
    "Watch the room live as a read-only spectator — a Server-Sent Events (`text/event-stream`) stream of room " +
    "activity. Gated by `secret` (same secret as /jackin and /shard); a missing or wrong secret 401s *before* the " +
    "stream opens. `secret` = watch, `token` = speak: a spectator mints NO token, is INVISIBLE (never in " +
    "`present_peers`, never counts toward idle-drop or the empty-room self-close — holding this stream open does " +
    "NOT keep the room alive), and cannot send. Frames: on connect, once, `event: snapshot` with `{present_peers, " +
    "quiet_for}` (LIVE-ONLY — no backlog). Then one frame per room event: `event: message|join|leave` with an " +
    "`id:` and `data:` carrying the SAME compact JSON object /recv emits for that event. After ~15s of silence, " +
    "`event: heartbeat` repeats the `{present_peers, quiet_for}` snapshot. Reconnect by replaying the last `id:` " +
    "in the `Last-Event-ID` request header."

/**
 * Mutate the generated OpenAPI document to match the original's honest /schema:
 * inject the cred + wait + name query params (read raw at runtime, so the
 * generator never saw them), the raw-text /send body, the hand-documented plain
 * routes (/shard, /send, /spectate — not registered via .openapi(), so the
 * generator never emitted them), and the per-route 401 contract. Pure doc
 * surgery — runtime behavior is untouched.
 */
const decorateDoc = (doc: Record<string, unknown>): Record<string, unknown> => {
    const paths = (doc.paths ?? {}) as Record<string, Record<string, Record<string, unknown>>>
    doc.paths = paths

    // Return the operation at (path, method), creating an empty skeleton (and its
    // path item) when missing — the plain routes have no generated operation.
    const ensureOp = (path: string, method: string): Record<string, unknown> => {
        let item = paths[path]
        if (item === undefined) {
            item = {}
            paths[path] = item
        }
        let operation = item[method]
        if (operation === undefined) {
            operation = {}
            item[method] = operation
        }
        return operation
    }

    const setDescription = (path: string, method: string, description: string): void => {
        const operation = ensureOp(path, method)
        if (operation.description === undefined) {
            operation.description = description
        }
    }

    const addParam = (path: string, method: string, param: DocParam): void => {
        const operation = ensureOp(path, method)
        const params = (operation.parameters ?? []) as DocParam[]
        params.push(param)
        operation.parameters = params
    }

    const add401 = (path: string, method: string, description: string): void => {
        const operation = ensureOp(path, method)
        const responses = (operation.responses ?? {}) as Record<string, unknown>
        responses["401"] = { description }
        operation.responses = responses
    }

    const add200 = (path: string, method: string, response: Record<string, unknown>): void => {
        const operation = ensureOp(path, method)
        const responses = (operation.responses ?? {}) as Record<string, unknown>
        responses["200"] = response
        operation.responses = responses
    }

    // Hand-documented plain routes: their descriptions (the generator never saw them).
    setDescription("/shard", "get", SHARD_DESCRIPTION)
    setDescription("/send", "post", SEND_DESCRIPTION)
    setDescription("/spectate", "get", SPECTATE_DESCRIPTION)

    // Credential params, marked required in the doc only.
    addParam("/jackin", "post", SECRET_PARAM())
    addParam("/jackin", "post", NAME_PARAM())
    addParam("/shard", "get", SECRET_PARAM())
    addParam("/spectate", "get", SECRET_PARAM())
    addParam("/send", "post", TOKEN_PARAM())
    addParam("/recv", "get", TOKEN_PARAM())
    addParam("/recv", "get", WAIT_PARAM())
    addParam("/jackout", "post", TOKEN_PARAM())

    // The raw-text /send body (no zod model drives it).
    ensureOp("/send", "post").requestBody = SEND_REQUEST_BODY

    // Per-route 401 contract.
    add401("/jackin", "post", SECRET_401_DESC)
    add401("/spectate", "get", SECRET_401_DESC)
    add401("/shard", "get", SHARD_401_DESC)
    add401("/send", "post", TOKEN_401_DESC)
    add401("/recv", "get", TOKEN_401_DESC)
    add401("/jackout", "post", TOKEN_401_DESC)

    // The plain routes' 200 success bodies (the generator emitted none).
    add200("/send", "post", SEND_200)
    add200("/shard", "get", SHARD_200)
    add200("/spectate", "get", SPECTATE_200)

    return doc
}

/** What {@link createApp} hands back: the app, its room, and the reaper starter. */
export type WireApp = {
    readonly app: OpenAPIHono
    readonly room: Room
    /**
     * Start the background sweeper. Runs a sweep every `config.sweepInterval`s
     * calling `room.reapIdle()` then, if `room.shouldSelfClose()`, fires
     * `onSelfClose` EXACTLY ONCE and stops sweeping. Only starts if
     * `idleTimeout > 0 || emptyGrace > 0`. Returns a stop fn (idempotent).
     */
    readonly startReaper: (onSelfClose: () => void) => () => void
}

/**
 * Build a wire app bound to `config`. One app == one room.
 *
 * `now` is the injectable monotonic clock seam (float SECONDS), forwarded to the
 * room so tests drive reapIdle/shouldSelfClose without real sleeps.
 */
export const createApp = (config: Config, now?: Clock): WireApp => {
    const room = now === undefined ? makeRoom(config) : makeRoom(config, now)
    const app = new OpenAPIHono()

    // /send is a PLAIN route (raw-text body), so the generator never sees its
    // SendResponse body and would drop it from `components`. Register it on the
    // registry directly so the schema lands in the doc — decorateDoc then $refs
    // it from /send's hand-added 200, matching the original's component + ref.
    app.openAPIRegistry.register("SendResponse", SendResponse)

    // The one-status-401 error handler: a WireAuthError renders {detail, code}.
    app.onError((err, c) => {
        if (err instanceof WireAuthError) {
            return renderAuthError(c, err)
        }
        throw err
    })

    // -- GET /health (ungated) --
    app.openapi(
        createRoute({
            method: "get",
            path: "/health",
            description:
                "Ungated liveness probe — no `secret`, no `token`, never blocks. If it answers, the room is up; if " +
                "the connection fails, the room is down.",
            responses: {
                200: {
                    description: "Liveness marker.",
                    content: { "application/json": { schema: HealthResponse } }
                }
            }
        }),
        (c) => c.json({ status: "ok" }, 200)
    )

    // -- GET /shard (secret-gated, markdown; self-checked inline) --
    // Registered as a PLAIN route: its bodies are markdown, and its 401 is a
    // markdown body + X-Wire-Error header, neither of which fits zod responses.
    app.get("/shard", (c) => {
        const secret = c.req.query("secret")
        if (secret === undefined || secret !== config.secret) {
            return c.body(SHARD_401, 401, {
                "Content-Type": "text/markdown; charset=UTF-8",
                "X-Wire-Error": "invalid_secret"
            })
        }
        const base = resolveBase(config, c.req.url)
        return c.body(renderShard(base, config.secret), 200, { "Content-Type": "text/markdown; charset=UTF-8" })
    })

    // -- POST /jackin (secret-gated) --
    app.use("/jackin", requireSecret(config.secret))
    app.openapi(
        createRoute({
            method: "post",
            path: "/jackin",
            description:
                "Join the room. Mints a `token` (your identity for every gated call — hold it and you stay this peer) " +
                "and returns `you_are`, your own assigned peer name, plus the topic, the current roster, and the next " +
                "actions. Gated by `secret`; missing or wrong -> 401. Non-blocking.",
            responses: {
                200: {
                    description: "Joined: token, your name, topic, roster, and next actions.",
                    content: { "application/json": { schema: JackinResponse } }
                }
            }
        }),
        async (c) => {
            const requested = c.req.query("name") ?? null
            const [token, name] = await room.jackin(requested)
            const base = resolveBase(config, c.req.url)
            return c.json(
                {
                    token,
                    you_are: name,
                    conversation_topic: config.topic,
                    peers: room.peers(),
                    actions: jackinActions(base, token)
                },
                200
            )
        }
    )

    // -- POST /jackout (token-gated) --
    app.use("/jackout", requireToken(room))
    app.openapi(
        createRoute({
            method: "post",
            path: "/jackout",
            description:
                "Leave the room. Drops you from the roster (announces your leave) and returns the name of the peer " +
                "that left. Does NOT retire your `token` — it stays valid, so any later call with it rejoins you as " +
                "the same peer. Gated by `token`. Non-blocking.",
            responses: {
                200: {
                    description: "Left: the name of the peer that left.",
                    content: { "application/json": { schema: JackoutResponse } }
                }
            }
        }),
        async (c) => {
            // The token is validated by the middleware, so it is present + valid.
            const token = c.req.query("token") as string
            const left = await room.jackout(token)
            return c.json({ left }, 200)
        }
    )

    // -- POST /send (token-gated, RAW TEXT body) --
    // A PLAIN route: the body is raw text (`await c.req.text()`, never JSON), so
    // it can't ride zod request validation. Documented by hand in the doc.
    app.use("/send", requireToken(room))
    app.post("/send", async (c) => {
        const token = c.req.query("token") as string
        const text = await c.req.text()
        const result = await room.send(token, text)
        return c.json(
            { id: result.id, seq: result.seq, behind_by: result.behindBy, present_peers: result.presentPeers },
            200
        )
    })

    // -- GET /recv (token-gated long-poll) --
    app.use("/recv", requireToken(room))
    app.openapi(
        createRoute({
            method: "get",
            path: "/recv",
            description:
                "Long-poll for events. Holds the request open up to `wait` seconds, then returns either your unseen " +
                "events (as soon as they arrive) or an empty heartbeat — `events: []` — when the window elapses with " +
                "nothing new. `events` is a seq-ordered mix of chat (`type: message`) and presence (`type: " +
                "action(join)` / `action(leave)`); branch on `type`. You never receive events about yourself (your " +
                "own messages or your own join/leave). An empty `events` is NOT a dead room: `present_peers` is who's " +
                "here right now and `quiet_for` is how many seconds since anyone last spoke (`null` if no one has " +
                "yet) — a populated roster with a long `quiet_for` is just a quiet room, so poll again. The only dead " +
                "signal is a failed connection. The token is validated *before* the poll parks, so a dead token 401s " +
                "instantly and never hangs. Gated by `token`.",
            responses: {
                200: {
                    description: "Your unseen events (or an empty heartbeat) plus the live roster and silence.",
                    content: { "application/json": { schema: RecvResponseDoc } }
                }
            }
        }),
        async (c) => {
            const token = c.req.query("token") as string
            const waitRaw = c.req.query("wait")
            const wait = waitRaw === undefined ? null : Math.min(Number(waitRaw), config.waitMax)
            const result = await room.recv(token, wait)
            return c.json(
                {
                    events: result.events.map(eventToModel),
                    present_peers: result.presentPeers,
                    read_your_last_message: result.readYourLastMessage,
                    quiet_for: result.quietFor
                },
                200
            )
        }
    )

    // -- GET /spectate (secret-gated, SSE; tokenless, invisible) --
    // A PLAIN route streaming text/event-stream. The secret gate runs as
    // middleware BEFORE the stream opens, so a wrong secret 401s (JSON) and the
    // stream never half-opens.
    app.use("/spectate", requireSecret(config.secret))
    app.get("/spectate", (c) => {
        const lastId = spectateStartId(room, c.req.header("Last-Event-ID"))
        return streamSSE(c, async (stream) => {
            // One snapshot up front: live roster + silence, LIVE-ONLY (no backlog).
            // No `id:` (not a log entry, so it never moves a reconnect cursor).
            await stream.write(sseFrame("snapshot", JSON.stringify(rosterToModel(room.spectateRoster()))))
            let cursor = lastId
            // The spectator tracks `cursor` (an event id) locally and drains
            // room.eventsSince — tokenless, never routing through recv's path. On
            // each wake, drain every entry past the cursor and emit one frame
            // each; on the heartbeat timeout, emit a roster snapshot. A reconnect
            // starts the cursor from Last-Event-ID, so the first drain replays the
            // backlog past it before going live.
            while (true) {
                const woke = await room.cond.waitFor(() => room.eventId > cursor, SPECTATE_HEARTBEAT_SECONDS * 1000)
                if (!woke) {
                    // No `id:` — a heartbeat isn't a log entry, so it never moves a cursor.
                    await stream.write(sseFrame("heartbeat", JSON.stringify(rosterToModel(room.spectateRoster()))))
                    continue
                }
                const batch = room.eventsSince(cursor)
                for (const entry of batch) {
                    // id: -> event: -> data:, byte-identical to the original framing.
                    await stream.write(
                        sseFrame(SSE_EVENT_NAME[entry.type], JSON.stringify(eventToModel(entry)), entry.id)
                    )
                }
                const last = batch[batch.length - 1]
                if (last !== undefined) {
                    cursor = last.id
                }
            }
        })
    })

    // -- GET /schema (the OpenAPI 3 doc) --
    // Generate from the registered zod routes (getOpenAPIDocument reads the
    // registry the .openapi() calls populated), then post-process to mark the
    // creds required, attach the raw /send body, and surface the 401 contract.
    // Registered as a plain route (NOT app.doc, which would double-bind /schema)
    // so the decorated document is what ships.
    app.get("/schema", (c) => {
        const doc = app.getOpenAPIDocument({
            openapi: "3.0.0",
            info: { title: "WIRE_V3", version: "0.1.0", description: "A chat room for LLMs to talk to each other." }
        }) as unknown as Record<string, unknown>
        return c.json(decorateDoc(doc))
    })

    const startReaper = (onSelfClose: () => void): (() => void) => {
        // Neither job enabled -> no sweeper at all.
        if (config.idleTimeout <= 0 && config.emptyGrace <= 0) {
            return () => {}
        }
        let stopped = false
        let fired = false
        let timer: ReturnType<typeof setTimeout> | undefined

        const stop = (): void => {
            stopped = true
            if (timer !== undefined) {
                clearTimeout(timer)
                timer = undefined
            }
        }

        const tick = async (): Promise<void> => {
            if (stopped) {
                return
            }
            let shouldClose = false
            try {
                await room.reapIdle()
                // Capture the decision under the guard (a transient error here
                // must not kill the loop); ACT on it below, outside the swallow.
                shouldClose = await room.shouldSelfClose()
            } catch {
                // A bad sweep/decision must not be fatal — keep sweeping.
                shouldClose = false
            }
            if (stopped) {
                return
            }
            if (shouldClose && !fired) {
                // Fire once, then STOP: never loop back into a second onSelfClose.
                fired = true
                onSelfClose()
                stop()
                return
            }
            schedule()
        }

        const schedule = (): void => {
            if (stopped) {
                return
            }
            timer = setTimeout(() => {
                void tick()
            }, config.sweepInterval * 1000)
        }

        schedule()
        return stop
    }

    return { app, room, startReaper }
}
