/**
 * peek.spec.ts — the /peek endpoint + the `pending` unread-count on every
 * token-authed response.
 *
 * Drives the app via `app.fetch(new Request(...))` (Hono's fetch handler), the
 * same in-memory harness app.spec.ts uses — no real port bound. Covers: /peek
 * returns pending + light headers; /peek does NOT advance the read-cursor (a
 * following /recv returns the same events); the 401 token gate; ~80-char preview
 * truncation; and `pending` present + correct on /jackin, /send, and /recv.
 */

import { describe, expect, it } from "bun:test"
import { createApp } from "./app"
import { type Config, makeConfig } from "./config"

const context = describe

const SECRET = "s3cret"
const TOPIC = "test room"
const BASE = "http://testserver"

/** Build a Config with the test defaults, overridable per case. */
const cfg = (overrides: Partial<Config> = {}): Config =>
    makeConfig({ host: "127.0.0.1", port: 0, secret: SECRET, topic: TOPIC, ...overrides })

/** A fresh app on the real clock (the common case). */
const makeApp = (overrides: Partial<Config> = {}) => createApp(cfg(overrides))

type App = { fetch: (r: Request) => Response | Promise<Response> }

/** GET against the in-memory app. `path` is appended to the testserver base. */
const get = (app: App, path: string): Promise<Response> =>
    Promise.resolve(app.fetch(new Request(`${BASE}${path}`, { method: "GET" })))

/** POST against the in-memory app, with an optional raw-text body. */
const post = (app: App, path: string, body?: string): Promise<Response> =>
    Promise.resolve(app.fetch(new Request(`${BASE}${path}`, { method: "POST", body })))

/** The /jackin body fields these tests read. */
type JackinBody = { token: string; you_are: string; pending: number }

/** Mint a peer via /jackin (asserts 200) and hand back its parsed body. */
const jackin = async (app: App, query = ""): Promise<JackinBody> => {
    const r = await post(app, `/jackin?secret=${SECRET}${query}`)
    expect(r.status).toBe(200)
    return (await r.json()) as JackinBody
}

/** The /peek body shape (headers are loose records — the tests assert their fields). */
type PeekBody = {
    pending: number
    headers: Record<string, unknown>[]
    present_peers: string[]
    quiet_for: number | null
}

/** GET /peek and parse (asserts 200). */
const peek = async (app: App, token: string): Promise<PeekBody> => {
    const r = await get(app, `/peek?token=${token}`)
    expect(r.status).toBe(200)
    return (await r.json()) as PeekBody
}

describe("wire /peek + pending", () => {
    // -- /peek returns the unread count and light headers ------------------

    context("/peek shape", () => {
        it("returns pending + headers (message header full, presence header type/from only)", async () => {
            const { app } = makeApp()
            const t1 = (await jackin(app)).token // peer-1, join id 1
            const t2 = (await jackin(app)).token // peer-2, join id 2
            await post(app, `/send?token=${t1}`, "hello") // message id 3

            const body = await peek(app, t2)
            // The body carries exactly pending/headers/present_peers/quiet_for.
            expect(new Set(Object.keys(body))).toEqual(new Set(["pending", "headers", "present_peers", "quiet_for"]))
            // peer-2's unread: peer-1's join (id 1) + the message (id 3). Its own
            // join (id 2) is filtered. pending equals the header count.
            expect(body.pending).toBe(2)
            expect(body.headers.length).toBe(2)
            expect(body.pending).toBe(body.headers.length)
            expect(new Set(body.present_peers)).toEqual(new Set(["peer-1", "peer-2"]))
            expect(body.quiet_for).toBe(0) // someone just spoke

            // The message header: id/type/from/seq/preview, nothing else.
            const msg = body.headers.find((h) => h.type === "message") as Record<string, unknown>
            expect({ id: msg.id, type: msg.type, from: msg.from, seq: msg.seq, preview: msg.preview }).toEqual({
                id: 3,
                type: "message",
                from: "peer-1",
                seq: 1,
                preview: "hello"
            })
            expect(new Set(Object.keys(msg))).toEqual(new Set(["id", "type", "from", "seq", "preview"]))

            // The presence header: type + from ONLY (no id, no seq, no preview).
            const join = body.headers.find((h) => h.type === "action(join)") as Record<string, unknown>
            expect(join.from).toBe("peer-1")
            expect(new Set(Object.keys(join))).toEqual(new Set(["type", "from"]))
        })

        it("a fully-drained peer peeks empty (pending 0, no headers)", async () => {
            const { app } = makeApp()
            const t1 = (await jackin(app)).token
            const t2 = (await jackin(app)).token
            await post(app, `/send?token=${t1}`, "hi")
            await get(app, `/recv?token=${t2}&wait=0`) // drain everything
            const body = await peek(app, t2)
            expect(body.pending).toBe(0)
            expect(body.headers).toEqual([])
        })
    })

    // -- /peek is NON-CONSUMING: the cursor never moves --------------------

    context("/peek does not consume", () => {
        it("peeking twice is idempotent and a following /recv returns the same events", async () => {
            const { app } = makeApp()
            const t1 = (await jackin(app)).token
            const t2 = (await jackin(app)).token
            await post(app, `/send?token=${t1}`, "one") // id 3
            await post(app, `/send?token=${t1}`, "two") // id 4

            // peer-2's unread: peer-1's join (id 1) + two messages (id 3, 4) = 3.
            const first = await peek(app, t2)
            expect(first.pending).toBe(3)

            // A second peek is identical — the cursor did not move.
            const second = await peek(app, t2)
            expect(second.pending).toBe(3)
            expect(second.headers).toEqual(first.headers)

            // The /recv AFTER the peeks still delivers those same events.
            const recv = (await (await get(app, `/recv?token=${t2}&wait=0`)).json()) as {
                events: Record<string, unknown>[]
                pending: number
            }
            expect(recv.events.length).toBe(3)
            const bodies = recv.events
                .filter((e) => e.type === "message")
                .map((e) => (e.message as { body: string }).body)
            expect(bodies).toEqual(["one", "two"])
            // recv delivered the count the peek predicted; now nothing is pending.
            expect(recv.pending).toBe(0)
            const after = await peek(app, t2)
            expect(after.pending).toBe(0)
            expect(after.headers).toEqual([])
        })
    })

    // -- the token gate: same one-status-401 as /recv ---------------------

    context("/peek token gate", () => {
        it("bogus token -> 401 {invalid_token}", async () => {
            const { app } = makeApp()
            const r = await get(app, "/peek?token=nope")
            expect(r.status).toBe(401)
            expect(await r.json()).toEqual({ detail: "invalid token", code: "invalid_token" })
        })

        it("missing token -> 401 not 422", async () => {
            const { app } = makeApp()
            const r = await get(app, "/peek")
            expect(r.status).toBe(401)
            expect(await r.json()).toEqual({ detail: "invalid token", code: "invalid_token" })
        })
    })

    // -- preview truncation at ~80 chars ----------------------------------

    context("preview truncation", () => {
        it("truncates a long body to the first 80 chars (no ellipsis); a short body is whole", async () => {
            const { app } = makeApp()
            const t1 = (await jackin(app)).token
            const t2 = (await jackin(app)).token
            const long = "x".repeat(200)
            await post(app, `/send?token=${t1}`, long) // id 3
            await post(app, `/send?token=${t1}`, "short") // id 4

            const body = await peek(app, t2)
            const previews = new Map(
                body.headers.filter((h) => h.type === "message").map((h) => [h.seq as number, h.preview as string])
            )
            // seq 1 is the 200-char body -> first 80 chars, exactly.
            expect(previews.get(1)?.length).toBe(80)
            expect(previews.get(1)).toBe(long.slice(0, 80))
            // seq 2 is the short body -> returned whole, untouched.
            expect(previews.get(2)).toBe("short")
        })

        it("an exactly-80-char body is preserved whole", async () => {
            const { app } = makeApp()
            const t1 = (await jackin(app)).token
            const t2 = (await jackin(app)).token
            const exact = "y".repeat(80)
            await post(app, `/send?token=${t1}`, exact)
            const body = await peek(app, t2)
            const msg = body.headers.find((h) => h.type === "message") as Record<string, unknown>
            expect((msg.preview as string).length).toBe(80)
            expect(msg.preview).toBe(exact)
        })
    })

    // -- `pending` rides every token-authed response ----------------------

    context("pending on jackin / send / recv", () => {
        it("is present and correct on /jackin, /send, and /recv", async () => {
            const { app } = makeApp()
            // First to join an empty room -> nothing waiting.
            const j1 = await jackin(app) // peer-1
            expect(j1.pending).toBe(0)
            // Second joiner sees peer-1's join (id 1) waiting.
            const j2 = await jackin(app) // peer-2
            expect(j2.pending).toBe(1)

            // peer-1 sends: its unread is peer-2's join (id 2) -> pending 1, and
            // behind_by 0 (behind_by counts chat from others only).
            const send = (await (await post(app, `/send?token=${j1.token}`, "hi")).json()) as {
                pending: number
                behind_by: number
            }
            expect(send.behind_by).toBe(0)
            expect(send.pending).toBe(1)

            // peer-2 recv drains everything -> caught up, pending 0.
            const recv = (await (await get(app, `/recv?token=${j2.token}&wait=0`)).json()) as { pending: number }
            expect(recv.pending).toBe(0)
        })

        it("pending counts presence + chat; behind_by counts chat only", async () => {
            const { app } = makeApp()
            const t1 = (await jackin(app)).token // peer-1
            const t2 = (await jackin(app)).token // peer-2
            await post(app, `/send?token=${t2}`, "one") // id 3
            await post(app, `/send?token=${t2}`, "two") // id 4

            const send = (await (await post(app, `/send?token=${t1}`, "q")).json()) as {
                behind_by: number
                pending: number
            }
            // behind_by: peer-2's two messages. pending: those two + peer-2's join = 3.
            expect(send.behind_by).toBe(2)
            expect(send.pending).toBe(3)
        })
    })

    // -- /schema documents /peek ------------------------------------------

    context("/schema honesty for /peek", () => {
        it("documents /peek: token required, a 401 invalid_token, and PeekResponse", async () => {
            const { app } = makeApp()
            // biome-ignore lint/suspicious/noExplicitAny: doc is a loose OpenAPI object
            const doc = (await (await get(app, "/schema")).json()) as any
            const op = doc.paths["/peek"].get
            expect(op).toBeDefined()
            // biome-ignore lint/suspicious/noExplicitAny: param objects are loose
            const token = (op.parameters ?? []).find((p: any) => p.name === "token" && p.in === "query")
            expect(token?.required).toBe(true)
            expect("401" in op.responses).toBe(true)
            expect(op.responses["401"].description).toContain("invalid_token")
            expect("200" in op.responses).toBe(true)
            const schema = doc.components.schemas.PeekResponse
            expect(schema).toBeDefined()
            expect(new Set(Object.keys(schema.properties))).toEqual(
                new Set(["pending", "headers", "present_peers", "quiet_for"])
            )
        })
    })
})
