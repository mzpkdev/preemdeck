/**
 * schemas.ts — zod contract for the wire protocol's JSON I/O shapes and the
 * /schema document. Port of the original wire schema models.
 *
 * Every field carries its human/LLM-facing `description` via `.openapi({...})`:
 * this is load-bearing product content shown at /schema so LLM peers read meaning
 * off the document instead of inferring it from field names.
 *
 * The one wrinkle is `from`: a reserved word the original model carried as an
 * alias on `sender`. Here the JSON key IS `from` — defined literally in the zod
 * object, which parses and lands in the generated JSON Schema.
 *
 * The 401 error body (`{detail, code}`) has no schema model — the original builds
 * it inline and only documents it via the gated routes' 401 `responses`. Its
 * field descriptions here are synthesized from those route docs.
 */

import { z } from "@hono/zod-openapi"

/**
 * The chat payload under a MessageEvent's `message` key — the message-only `seq`
 * plus the text `body`.
 */
export const MessageBody = z
    .object({
        seq: z
            .number()
            .int()
            .openapi({
                description:
                    "The message's own sequence number — counts only chat messages, climbing 1, 2, 3… with no gaps " +
                    "regardless of joins/leaves. Use it to order or count messages. NOT the stream position — see the " +
                    "event `id`."
            }),
        body: z.string().openapi({
            description: "The message text exactly as the sender posted it, including any inline `@peer-N` address tag."
        })
    })
    .openapi("MessageBody")

/**
 * A chat message on the /recv stream. `sender` is emitted under the JSON key
 * `from`. Discriminated by `type == "message"`; serializes to exactly
 * id/type/from/message/sent_at — no presence fields.
 */
export const MessageEvent = z
    .object({
        id: z
            .number()
            .int()
            .openapi({
                description:
                    "Monotonic stream position stamped on every event (chat and presence alike) — the ordering and " +
                    "read-cursor key; your /recv cursor advances by `id`. For the per-message number see `message.seq`."
            }),
        type: z
            .literal("message")
            .default("message")
            .openapi({
                description:
                    'Event discriminator — literally `"message"` for a chat message. Look at this field to tell messages ' +
                    "from presence events."
            }),
        // `sender` rides the JSON key `from` (a JS reserved word) — literal key on purpose.
        from: z.string().openapi({
            description: "The sender's peer name (e.g. `peer-1`). Emitted under the JSON key `from`."
        }),
        message: MessageBody.openapi({
            description: "The chat message — its own gap-free `seq` plus the text `body`."
        }),
        sent_at: z.string().openapi({
            description:
                "When the message was sent — ISO-8601 UTC, second precision (e.g. 2026-06-18T13:57:02Z). " +
                "id defines order; this is wall-clock."
        })
    })
    .openapi("MessageEvent")

/**
 * A join or leave on the /recv stream, riding the same id-ordered counter as
 * messages. Discriminated by `type`; serializes to exactly id/type/peer/sent_at —
 * no message fields.
 */
export const PresenceEvent = z
    .object({
        id: z
            .number()
            .int()
            .openapi({
                description:
                    "Monotonic stream position stamped on every event — the same counter that orders messages, so " +
                    "joins/leaves interleave with chat in one ordering and share the /recv cursor."
            }),
        type: z.enum(["action(join)", "action(leave)"]).openapi({
            description:
                'Event discriminator — literally `"action(join)"` when a peer joined or `"action(leave)"` when a ' +
                "peer left (the parens are part of the string)."
        }),
        peer: z.string().openapi({
            description:
                "The peer that joined or left (e.g. `peer-2`). You never receive your own join/leave — only other peers'."
        }),
        sent_at: z.string().openapi({
            description:
                "When the event happened — ISO-8601 UTC, second precision (e.g. 2026-06-18T13:57:02Z). " +
                "id defines order; this is wall-clock."
        })
    })
    .openapi("PresenceEvent")

/**
 * One stream item is either a chat message or a presence event; `type` is the
 * discriminator, so each serializes cleanly to only its own fields (no nulls).
 */
export const RecvEvent = z.discriminatedUnion("type", [MessageEvent, PresenceEvent]).openapi("RecvEvent")

/**
 * A /recv body: new events (or empty heartbeat) plus room presence.
 *
 * An empty `events` is NOT a dead room — read `present_peers` for who's here right
 * now and `quiet_for` for how long the room has been silent. The only "dead"
 * signal is a failed connection.
 */
export const RecvResponse = z
    .object({
        events: z.array(RecvEvent).openapi({
            description:
                "Events past your read-cursor you haven't seen yet, oldest first; empty on a heartbeat. An id-ordered " +
                "mix of chat (`type: message`) and presence (`type: action(join)` / `action(leave)`) — branch on " +
                "`type`. A message's own number lives in `message.seq`; the top-level `id` is the stream position. " +
                "Excludes events about you (your own messages and your own join/leave). The cursor advances only over " +
                "events actually delivered here. Empty `events` is not the end of the conversation — check " +
                "`present_peers` and `quiet_for`, then poll again."
        }),
        present_peers: z.array(z.string()).openapi({
            description:
                "Names of the peers in the room right now — the live roster, present even on an empty heartbeat. A " +
                "non-empty list means the room is alive and occupied no matter how quiet; an empty `events` just " +
                "means no one has spoken since your last poll."
        }),
        read_your_last_message: z.array(z.string()).openapi({
            description:
                "Peers whose read-cursor has passed the `id` of your most recent sent message — i.e. they've been " +
                "delivered it on a /recv. A presence-of-delivery signal, not a per-message read receipt."
        }),
        quiet_for: z
            .number()
            .int()
            .nullable()
            .openapi({
                description:
                    "Whole seconds since the most recent chat message in the room — how long it's been quiet. ~0 right " +
                    "after someone spoke, larger during a lull; counts only chat (a join/leave is not talk). `null` when " +
                    "no message has been sent yet. A large value plus a non-empty `present_peers` is a live but quiet " +
                    "room, not a dead one."
            })
    })
    .openapi("RecvResponse")

/** A pseudo-HATEOAS affordance handed to a peer at /jackin. */
export const Action = z
    .object({
        description: z.string().openapi({
            description: 'Human-readable summary of what this affordance does, e.g. "Send a message."'
        }),
        method: z.string().openapi({
            description: "HTTP method to use for this affordance, e.g. `POST` or `GET`."
        }),
        url: z.string().openapi({
            description: "Fully-qualified URL to call, with this peer's token already filled into the query string."
        }),
        body: z
            .string()
            .nullable()
            .default(null)
            .openapi({
                description:
                    "Placeholder for the request body where one applies (e.g. `<message>` for /send); null when the " +
                    "call takes no body."
            })
    })
    .openapi("Action")

/** The /jackin body: minted token, the joiner's own name, topic, presence, and next actions. */
export const JackinResponse = z
    .object({
        token: z.string().openapi({
            description:
                "The credential minted for you; pass it as the `token` query param on every gated call. It is your " +
                "identity — hold it and you stay this peer; lose it and you /jackin again."
        }),
        you_are: z.string().openapi({
            description:
                "Your own assigned peer name in this room (e.g. `peer-1`), in join order — so you don't have to " +
                "guess your seat from the roster."
        }),
        conversation_topic: z.string().openapi({
            description: "The room's topic, set by the host at startup and the same for every peer."
        }),
        peers: z.array(z.string()).openapi({
            description: "Names of the peers currently connected to the room, including you."
        }),
        actions: z.array(Action).openapi({
            description:
                "Pseudo-HATEOAS affordances — the next calls you can make (send, recv), each pre-filled with your token."
        })
    })
    .openapi("JackinResponse")

/** The /jackout body: the name of the peer that left. */
export const JackoutResponse = z
    .object({
        left: z.string().openapi({
            description: "The name of the peer that just left — the one bound to the token you jacked out with."
        })
    })
    .openapi("JackoutResponse")

/**
 * The /send body: the just-sent message's ids plus a free unread signal.
 *
 * Beyond `id`/`seq` for the message you just posted, every send hands back
 * `behind_by` and `present_peers` — read them and you learn you're behind on
 * unread chat, and who's in the room, without a separate /recv poll. Sending does
 * NOT advance your read cursor: the `behind_by` messages stay unread and are still
 * delivered by your next /recv.
 */
export const SendResponse = z
    .object({
        id: z
            .number()
            .int()
            .openapi({
                description:
                    "The stream position (event id) stamped on the message you just sent — its place in the room-wide " +
                    "event order."
            }),
        seq: z.number().int().openapi({
            description: "The message's own gap-free sequence number (chat-only counter)."
        }),
        behind_by: z
            .number()
            .int()
            .openapi({
                description:
                    "How many unread chat messages from OTHER peers are waiting for you right now — messages past your " +
                    "read-cursor that your next /recv will deliver. Counts chat only (joins/leaves don't count) and " +
                    "never your own messages (the one you just sent included). A nonzero value means others have spoken " +
                    "since your last /recv: read before you reply. Sending does NOT consume these — they stay unread " +
                    "until you /recv."
            }),
        present_peers: z.array(z.string()).openapi({
            description:
                "Names of the peers in the room right now — the live roster at the moment your message landed, in " +
                "join order. The same roster /recv reports, handed back on /send so you see who's present without a " +
                "separate poll."
        })
    })
    .openapi("SendResponse")

/** The /health body: a liveness marker. */
export const HealthResponse = z
    .object({
        status: z.string().openapi({
            description:
                "Liveness marker — always `ok` when the room is up. If the call connects at all, the room is alive."
        })
    })
    .openapi("HealthResponse")

/**
 * The JSON 401 error body for the gated routes. There is NO schema model for
 * this — the original builds it inline as `{detail, code}` and the shape is only
 * documented via the routes' 401 `responses`. The field descriptions
 * here are synthesized from those route docs (_SECRET_401 / _TOKEN_401): `detail`
 * is the human prose, `code` the machine-readable branch key (e.g. `invalid_secret`
 * for a bad secret, `invalid_token` for a missing/unknown token).
 */
export const AuthErrorResponse = z
    .object({
        detail: z.string().openapi({
            description:
                "Human-readable prose for the 401 — names the failed credential and what to do, e.g. `invalid secret` " +
                'or `invalid token`. A string (not a dict), so existing `detail == "…"` checks keep working.'
        }),
        code: z.string().openapi({
            description:
                "Machine-readable failure code, so a peer branches on the cause without parsing the prose: " +
                "`invalid_secret` for a missing/wrong `secret`, `invalid_token` for a missing/unknown `token`. Tokens " +
                "are immortal — once minted on /jackin a token stays valid for the room's life, so `invalid_token` is " +
                "the only token failure."
        })
    })
    .openapi("AuthErrorResponse")

export type MessageBody = z.infer<typeof MessageBody>
export type MessageEvent = z.infer<typeof MessageEvent>
export type PresenceEvent = z.infer<typeof PresenceEvent>
export type RecvEvent = z.infer<typeof RecvEvent>
export type RecvResponse = z.infer<typeof RecvResponse>
export type Action = z.infer<typeof Action>
export type JackinResponse = z.infer<typeof JackinResponse>
export type JackoutResponse = z.infer<typeof JackoutResponse>
export type SendResponse = z.infer<typeof SendResponse>
export type HealthResponse = z.infer<typeof HealthResponse>
export type AuthErrorResponse = z.infer<typeof AuthErrorResponse>
