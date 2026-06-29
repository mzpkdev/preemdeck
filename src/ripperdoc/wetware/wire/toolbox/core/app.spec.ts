/**
 * app.spec.ts — the HTTP layer over the frozen room core.
 *
 * Drives the app via `app.fetch(new Request(...))` (Hono's fetch handler) — no
 * real port bound for the JSON cases. SSE (/spectate) reads the streamed Response
 * body incrementally under a bounded frame-count + timeout, then cancels, so the
 * endless stream can never hang the test.
 *
 * The one-status-401 contract (three distinct bodies), the jackin -> send ->
 * recv loop, jackout, the heartbeat, /schema honesty, the SSE snapshot/event/
 * heartbeat/replay/invisibility surface, and the reaper start-gate + self-close
 * hook are all covered. recv cases use wait=0 to stay fast — the parked-wake
 * concurrency is proven at the unit layer (room.spec.ts).
 */

import { describe, expect, it } from "bun:test"
import { createApp } from "./app"
import { fakeClock } from "./clock"
import { type Config, makeConfig } from "./config"

const context = describe

const SECRET = "s3cret"
const TOPIC = "test room"
const PUBLIC_URL = "https://wire.example.com"
const BASE = "http://testserver"

// ISO-8601 UTC, second precision, Z-suffixed: e.g. 2026-06-18T13:57:02Z.
const ISO_UTC_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

/** Build a Config with the test defaults, overridable per case. */
const cfg = (overrides: Partial<Config> = {}): Config =>
    makeConfig({ host: "127.0.0.1", port: 0, secret: SECRET, topic: TOPIC, ...overrides })

/** A fresh app on the real clock (the common case). */
const makeApp = (overrides: Partial<Config> = {}) => createApp(cfg(overrides))

/** GET against the in-memory app. `path` is appended to the testserver base. */
const get = (app: { fetch: (r: Request) => Response | Promise<Response> }, path: string): Promise<Response> =>
    Promise.resolve(app.fetch(new Request(`${BASE}${path}`, { method: "GET" })))

/** POST against the in-memory app, with an optional raw-text body. */
const post = (
    app: { fetch: (r: Request) => Response | Promise<Response> },
    path: string,
    body?: string
): Promise<Response> => Promise.resolve(app.fetch(new Request(`${BASE}${path}`, { method: "POST", body })))

/** Mint a token via /jackin (asserts 200). */
const jackin = async (app: { fetch: (r: Request) => Response | Promise<Response> }): Promise<string> => {
    const r = await post(app, `/jackin?secret=${SECRET}`)
    expect(r.status).toBe(200)
    return ((await r.json()) as { token: string }).token
}

// ========================================================================
// SSE harness — open /spectate, pull a bounded number of frames, then cancel.
// Hang-proof: a frame-count cap + a deadline, so the endless stream never hangs.
// ========================================================================

type Frame = { event: string | null; id: number | null; data: unknown }

/** One blank-line-delimited SSE frame -> {event, id, data}. Asserts exactly one data: line. */
const parseFrame = (raw: string): Frame => {
    const out: Frame = { event: null, id: null, data: null }
    let dataLines = 0
    for (const line of raw.split("\n")) {
        if (line.startsWith("id: ")) {
            out.id = Number(line.slice("id: ".length))
        } else if (line.startsWith("event: ")) {
            out.event = line.slice("event: ".length)
        } else if (line.startsWith("data: ")) {
            dataLines += 1
            out.data = JSON.parse(line.slice("data: ".length))
        }
    }
    expect(dataLines).toBe(1)
    return out
}

/**
 * Open /spectate on `app`, collect `n` SSE frames, then cancel the stream.
 *
 * `afterOpen` fires after the first frame (the snapshot) lands — the seam to
 * drive room activity once the spectator is genuinely live, so a join/send/leave
 * is observed as a live event rather than racing the snapshot. Every wait is
 * bounded by `timeoutMs`.
 */
const collectFrames = async (
    app: { fetch: (r: Request) => Response | Promise<Response> },
    n: number,
    opts: { headers?: Record<string, string>; afterOpen?: () => Promise<void>; timeoutMs?: number } = {}
): Promise<{ status: number; contentType: string; frames: Frame[] }> => {
    const timeoutMs = opts.timeoutMs ?? 5000
    const resp = await Promise.resolve(
        app.fetch(new Request(`${BASE}/spectate?secret=${SECRET}`, { method: "GET", headers: opts.headers }))
    )
    const status = resp.status
    const contentType = resp.headers.get("content-type") ?? ""
    const frames: Frame[] = []
    if (resp.body === null) {
        return { status, contentType, frames }
    }
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    let firedAfterOpen = false
    const deadline = Date.now() + timeoutMs

    try {
        while (frames.length < n) {
            if (Date.now() > deadline) {
                throw new Error(`timed out waiting for ${n} SSE frames; got ${frames.length}`)
            }
            const readP = reader.read()
            const timed = new Promise<{ done: true; value: undefined }>((resolve) =>
                setTimeout(() => resolve({ done: true, value: undefined }), Math.max(0, deadline - Date.now()))
            )
            const { done, value } = await Promise.race([readP, timed])
            if (done) {
                if (value === undefined && frames.length < n) {
                    // Either the stream closed or our timeout fired; loop re-checks
                    // the deadline and throws if exceeded.
                    if (Date.now() > deadline) {
                        throw new Error(`timed out waiting for ${n} SSE frames; got ${frames.length}`)
                    }
                    continue
                }
                break
            }
            buf += decoder.decode(value, { stream: true })
            let idx = buf.indexOf("\n\n")
            while (idx !== -1) {
                const raw = buf.slice(0, idx)
                buf = buf.slice(idx + 2)
                frames.push(parseFrame(raw))
                if (!firedAfterOpen && opts.afterOpen !== undefined) {
                    firedAfterOpen = true
                    await opts.afterOpen()
                }
                idx = buf.indexOf("\n\n")
            }
        }
    } finally {
        await reader.cancel().catch(() => {})
    }
    return { status, contentType, frames }
}

describe("wire HTTP app", () => {
    // -- ungated probes ---------------------------------------------------

    context("ungated probes", () => {
        it("GET /health returns {status: ok}", async () => {
            const { app } = makeApp()
            const r = await get(app, "/health")
            expect(r.status).toBe(200)
            expect(await r.json()).toEqual({ status: "ok" })
        })

        it("GET /schema is an OpenAPI 3 doc with the routes", async () => {
            const { app } = makeApp()
            const r = await get(app, "/schema")
            expect(r.status).toBe(200)
            const doc = (await r.json()) as { openapi: string; paths: Record<string, unknown> }
            expect(doc.openapi.startsWith("3.")).toBe(true)
            expect("/jackin" in doc.paths).toBe(true)
            expect("/recv" in doc.paths).toBe(true)
        })
    })

    // -- /shard (markdown, self-checked secret) ---------------------------

    context("/shard", () => {
        it("wrong secret -> 401 markdown + X-Wire-Error header", async () => {
            const { app } = makeApp()
            const r = await get(app, "/shard?secret=wrong")
            expect(r.status).toBe(401)
            expect(r.headers.get("content-type")?.startsWith("text/markdown")).toBe(true)
            expect(await r.text()).toBe("You are not authorized to view this resource, your secret is invalid.")
            expect(r.headers.get("x-wire-error")).toBe("invalid_secret")
        })

        it("missing secret -> 401 markdown + X-Wire-Error header", async () => {
            const { app } = makeApp()
            const r = await get(app, "/shard")
            expect(r.status).toBe(401)
            expect(r.headers.get("content-type")?.startsWith("text/markdown")).toBe(true)
            expect(r.headers.get("x-wire-error")).toBe("invalid_secret")
        })

        it("correct secret -> 200 markdown with request base + secret interpolated", async () => {
            const { app } = makeApp()
            const r = await get(app, `/shard?secret=${SECRET}`)
            expect(r.status).toBe(200)
            expect(r.headers.get("content-type")?.startsWith("text/markdown")).toBe(true)
            const text = await r.text()
            expect(text.startsWith("# WIRE")).toBe(true)
            expect(text).toContain(BASE)
            expect(text).toContain(SECRET)
            expect(text).not.toContain("$URL")
            expect(text).not.toContain("$SECRET")
            // $TOKEN stays literal — unknown until /jackin mints one.
            expect(text).toContain("$TOKEN")
        })

        it("with public_url -> manual carries the public URL, not the request base", async () => {
            const { app } = makeApp({ publicUrl: PUBLIC_URL })
            const r = await get(app, `/shard?secret=${SECRET}`)
            const text = await r.text()
            expect(text).toContain(PUBLIC_URL)
            expect(text).not.toContain("testserver")
            expect(text).not.toContain("$URL")
            expect(text).toContain(SECRET)
            expect(text).toContain("$TOKEN")
        })
    })

    // -- /jackin secret gate ----------------------------------------------

    context("/jackin secret gate", () => {
        it("wrong secret -> 401 {detail, code}", async () => {
            const { app } = makeApp()
            const r = await post(app, "/jackin?secret=wrong")
            expect(r.status).toBe(401)
            expect(await r.json()).toEqual({ detail: "invalid secret", code: "invalid_secret" })
        })

        it("missing secret -> 401 {detail, code}", async () => {
            const { app } = makeApp()
            const r = await post(app, "/jackin")
            expect(r.status).toBe(401)
            expect(await r.json()).toEqual({ detail: "invalid secret", code: "invalid_secret" })
        })

        it("correct secret -> 200 with token, topic, roster, and actions", async () => {
            const { app } = makeApp()
            const r = await post(app, `/jackin?secret=${SECRET}`)
            expect(r.status).toBe(200)
            const body = (await r.json()) as {
                token: string
                conversation_topic: string
                peers: string[]
                actions: { method: string; url: string; body: string | null }[]
            }
            expect(body.token).toBeTruthy()
            expect(body.conversation_topic).toBe(TOPIC)
            expect(body.peers).toEqual(["peer-1"])
            expect(body.actions.length).toBe(2)
            const [sendAction, recvAction] = body.actions
            expect(sendAction?.method).toBe("POST")
            expect(sendAction?.url.endsWith(`/send?token=${body.token}`)).toBe(true)
            expect(sendAction?.body).toBe("<message>")
            expect(recvAction?.method).toBe("GET")
            expect(recvAction?.url.endsWith(`/recv?token=${body.token}`)).toBe(true)
        })
    })

    // -- optional self-naming at /jackin ----------------------------------

    context("/jackin self-naming", () => {
        it("a requested name is suffixed -> <name>-1", async () => {
            const { app } = makeApp()
            const r = await post(app, `/jackin?secret=${SECRET}&name=alice`)
            const body = (await r.json()) as { you_are: string; peers: string[] }
            expect(body.you_are).toBe("alice-1")
            expect(body.peers).toEqual(["alice-1"])
        })

        it("a requested name is normalized -> my-agent-1", async () => {
            const { app } = makeApp()
            const r = await post(app, `/jackin?secret=${SECRET}&name=${encodeURIComponent("  My Agent  ")}`)
            expect(((await r.json()) as { you_are: string }).you_are).toBe("my-agent-1")
        })

        it("a repeated name increments n", async () => {
            const { app } = makeApp()
            const first = await post(app, `/jackin?secret=${SECRET}&name=alice`)
            expect(((await first.json()) as { you_are: string }).you_are).toBe("alice-1")
            const second = await post(app, `/jackin?secret=${SECRET}&name=alice`)
            expect(((await second.json()) as { you_are: string }).you_are).toBe("alice-2")
        })

        it("no name -> peer-N in join order", async () => {
            const { app } = makeApp()
            const r1 = await post(app, `/jackin?secret=${SECRET}`)
            expect(((await r1.json()) as { you_are: string }).you_are).toBe("peer-1")
            const r2 = await post(app, `/jackin?secret=${SECRET}`)
            expect(((await r2.json()) as { you_are: string }).you_are).toBe("peer-2")
        })

        it("the name param does not bypass the secret gate", async () => {
            const { app } = makeApp()
            const r = await post(app, "/jackin?name=alice")
            expect(r.status).toBe(401)
            expect(await r.json()).toEqual({ detail: "invalid secret", code: "invalid_secret" })
        })
    })

    // -- one-401 contract: token endpoints with a bogus / missing token ---

    context("one-status-401 on token routes", () => {
        it.each([
            ["GET /recv bogus token", "get", "/recv?token=nope"],
            ["POST /jackout bogus token", "post", "/jackout?token=nope"],
            ["GET /recv missing token", "get", "/recv"],
            ["POST /jackout missing token (not 422)", "post", "/jackout"]
        ] as [string, "get" | "post", string][])("%s -> 401 {invalid_token}", async (_name, method, path) => {
            const { app } = makeApp()
            const r = method === "get" ? await get(app, path) : await post(app, path)
            expect(r.status).toBe(401)
            expect(await r.json()).toEqual({ detail: "invalid token", code: "invalid_token" })
        })

        it("POST /send bogus token -> 401 {invalid_token}", async () => {
            const { app } = makeApp()
            const r = await post(app, "/send?token=nope", "hi")
            expect(r.status).toBe(401)
            expect(await r.json()).toEqual({ detail: "invalid token", code: "invalid_token" })
        })

        it("POST /send missing token -> 401 not 422", async () => {
            const { app } = makeApp()
            const r = await post(app, "/send", "hi")
            expect(r.status).toBe(401)
            expect(await r.json()).toEqual({ detail: "invalid token", code: "invalid_token" })
        })
    })

    // -- the loop: jackin x2, send, recv ----------------------------------

    context("send/recv loop", () => {
        it("delivers a message clean per-type, with no-echo for the sender", async () => {
            const { app } = makeApp()
            const r1 = await post(app, `/jackin?secret=${SECRET}`)
            const b1 = (await r1.json()) as { you_are: string; token: string }
            expect(b1.you_are).toBe("peer-1")
            const t1 = b1.token
            const r2 = await post(app, `/jackin?secret=${SECRET}`)
            const b2 = (await r2.json()) as { you_are: string; token: string }
            expect(b2.you_are).toBe("peer-2")
            const t2 = b2.token

            // peer-1 sends raw text: two joins took ids 1,2 so the message event id
            // is 3, but it's the FIRST chat -> seq 1. behind_by 0 (own msg never counts).
            const sendR = await post(app, `/send?token=${t1}`, "hello peer-2")
            expect(sendR.status).toBe(200)
            expect(await sendR.json()).toEqual({
                id: 3,
                seq: 1,
                behind_by: 0,
                present_peers: ["peer-1", "peer-2"]
            })

            // peer-2 reads it (wait=0). Picks the message; sees peer-1's join (id 1).
            const recvR = await get(app, `/recv?token=${t2}&wait=0`)
            expect(recvR.status).toBe(200)
            const body = (await recvR.json()) as {
                events: Record<string, unknown>[]
                present_peers: string[]
                read_your_last_message: string[]
            }
            const msgs = body.events.filter((e) => e.type === "message")
            expect(msgs.length).toBe(1)
            const msg = msgs[0] as Record<string, unknown>
            expect({ id: msg.id, type: msg.type, from: msg.from, message: msg.message }).toEqual({
                id: 3,
                type: "message",
                from: "peer-1",
                message: { seq: 1, body: "hello peer-2" }
            })
            expect("peer" in msg).toBe(false)
            expect(ISO_UTC_Z_RE.test(msg.sent_at as string)).toBe(true)
            const join = body.events.find((e) => e.type === "action(join)") as Record<string, unknown>
            expect({ id: join.id, type: join.type, peer: join.peer }).toEqual({
                id: 1,
                type: "action(join)",
                peer: "peer-1"
            })
            expect("from" in join).toBe(false)
            expect("message" in join).toBe(false)
            expect(new Set(body.present_peers)).toEqual(new Set(["peer-1", "peer-2"]))
            expect(body.read_your_last_message).toEqual([])

            // peer-1 polls: no echo of its own message/join; sees peer-2's join.
            const recv1 = await get(app, `/recv?token=${t1}&wait=0`)
            const body1 = (await recv1.json()) as {
                events: Record<string, unknown>[]
                read_your_last_message: string[]
            }
            expect(body1.events.filter((e) => e.type === "message")).toEqual([])
            expect(body1.events.map((e) => [e.type, e.peer])).toEqual([["action(join)", "peer-2"]])
            expect(body1.read_your_last_message).toEqual(["peer-2"])
        })

        it("/send reports behind_by from OTHERS without consuming it", async () => {
            const { app } = makeApp()
            const t1 = await jackin(app)
            const t2 = await jackin(app)
            await post(app, `/send?token=${t2}`, "one")
            await post(app, `/send?token=${t2}`, "two")
            const body = (await (await post(app, `/send?token=${t1}`, "caught up?")).json()) as {
                behind_by: number
                present_peers: string[]
            }
            expect(body.behind_by).toBe(2)
            expect(new Set(body.present_peers)).toEqual(new Set(["peer-1", "peer-2"]))
            // send didn't advance peer-1's cursor — its next /recv still delivers both.
            const recv = (await (await get(app, `/recv?token=${t1}&wait=0`)).json()) as {
                events: Record<string, unknown>[]
            }
            const bodies = recv.events
                .filter((e) => e.type === "message")
                .map((e) => (e.message as { body: string }).body)
            expect(bodies).toEqual(["one", "two"])
        })

        it("a delivered message carries sent_at in ISO-8601 UTC Z form", async () => {
            const { app } = makeApp()
            const t1 = await jackin(app)
            const t2 = await jackin(app)
            await post(app, `/send?token=${t1}`, "timestamped")
            const r = await get(app, `/recv?token=${t2}&wait=0`)
            const events = ((await r.json()) as { events: Record<string, unknown>[] }).events
            const msgs = events.filter((e) => e.type === "message")
            expect(msgs.length).toBeGreaterThan(0)
            expect(ISO_UTC_Z_RE.test((msgs[0] as Record<string, unknown>).sent_at as string)).toBe(true)
        })
    })

    // -- jackout: drops from roster, token stays immortal -----------------

    context("jackout", () => {
        it("drops the peer from the roster and returns {left}", async () => {
            const { app } = makeApp()
            const t1 = await jackin(app)
            const t2 = await jackin(app)
            const r = await post(app, `/jackout?token=${t2}`)
            expect(r.status).toBe(200)
            expect(await r.json()).toEqual({ left: "peer-2" })
            const body = (await (await get(app, `/recv?token=${t1}&wait=0`)).json()) as { present_peers: string[] }
            expect(body.present_peers).toEqual(["peer-1"])
        })

        it("the token survives jackout and a later call rejoins the peer", async () => {
            const { app } = makeApp()
            const t1 = await jackin(app)
            const t2 = await jackin(app)
            await post(app, `/jackout?token=${t2}`)
            const r = await post(app, `/send?token=${t2}`, "back again")
            expect(r.status).toBe(200)
            expect("seq" in ((await r.json()) as object)).toBe(true)
            const body = (await (await get(app, `/recv?token=${t1}&wait=0`)).json()) as { present_peers: string[] }
            expect(body.present_peers).toContain("peer-2")
            expect((await get(app, `/recv?token=${t2}&wait=0`)).status).toBe(200)
            expect((await post(app, `/jackout?token=${t2}`)).status).toBe(200)
        })
    })

    // -- presence events over HTTP ----------------------------------------

    context("presence over HTTP", () => {
        it("a join lands clean per-type (id/type/peer/sent_at, no nulls)", async () => {
            const { app } = makeApp()
            const ta = await jackin(app)
            await get(app, `/recv?token=${ta}&wait=0`) // drain own join -> empty
            await jackin(app) // peer-2 joins
            const r = await get(app, `/recv?token=${ta}&wait=0`)
            const joins = ((await r.json()) as { events: Record<string, unknown>[] }).events.filter(
                (e) => e.type === "action(join)"
            )
            expect(joins.length).toBe(1)
            const join = joins[0] as Record<string, unknown>
            expect(new Set(Object.keys(join))).toEqual(new Set(["id", "type", "peer", "sent_at"]))
            expect(join.peer).toBe("peer-2")
            expect(ISO_UTC_Z_RE.test(join.sent_at as string)).toBe(true)
        })

        it("a leave lands clean per-type", async () => {
            const { app } = makeApp()
            const ta = await jackin(app)
            const tb = await jackin(app)
            await get(app, `/recv?token=${ta}&wait=0`) // drain peer-2's join
            expect(await (await post(app, `/jackout?token=${tb}`)).json()).toEqual({ left: "peer-2" })
            const r = await get(app, `/recv?token=${ta}&wait=0`)
            const leaves = ((await r.json()) as { events: Record<string, unknown>[] }).events.filter(
                (e) => e.type === "action(leave)"
            )
            expect(leaves.length).toBe(1)
            const leave = leaves[0] as Record<string, unknown>
            expect(new Set(Object.keys(leave))).toEqual(new Set(["id", "type", "peer", "sent_at"]))
            expect(leave.peer).toBe("peer-2")
        })

        it("a peer never sees its own join", async () => {
            const { app } = makeApp()
            const ta = await jackin(app)
            const r0 = await get(app, `/recv?token=${ta}&wait=0`)
            expect(((await r0.json()) as { events: unknown[] }).events).toEqual([])
            await jackin(app) // peer-2
            const r = await get(app, `/recv?token=${ta}&wait=0`)
            const peersInEvents = new Set(
                ((await r.json()) as { events: Record<string, unknown>[] }).events
                    .filter((e) => (e.type as string).startsWith("action"))
                    .map((e) => e.peer)
            )
            expect(peersInEvents.has("peer-1")).toBe(false)
            expect(peersInEvents).toEqual(new Set(["peer-2"]))
        })

        it("a late joiner backfills others' join + message", async () => {
            const { app } = makeApp()
            const ta = await jackin(app)
            await post(app, `/send?token=${ta}`, "early")
            const tb = await jackin(app)
            const r = await get(app, `/recv?token=${tb}&wait=0`)
            const shape = ((await r.json()) as { events: Record<string, unknown>[] }).events.map((e) => [e.id, e.type])
            expect(shape).toEqual([
                [1, "action(join)"],
                [2, "message"]
            ])
        })

        it("message.seq stays contiguous while event id straddles a wedged join", async () => {
            const { app } = makeApp()
            const ta = await jackin(app) // peer-1, join id 1
            const tb = await jackin(app) // peer-2, join id 2
            const first = (await (await post(app, `/send?token=${ta}`, "ping")).json()) as { id: number; seq: number }
            expect({ id: first.id, seq: first.seq }).toEqual({ id: 3, seq: 1 })
            await post(app, `/jackout?token=${tb}`) // id 4: leave
            await get(app, `/recv?token=${tb}&wait=0`) // id 5: rejoin (no chat)
            const second = (await (await post(app, `/send?token=${ta}`, "pong")).json()) as { id: number; seq: number }
            expect({ id: second.id, seq: second.seq }).toEqual({ id: 6, seq: 2 })

            const tc = await jackin(app) // fresh observer, backfills the whole stream
            const body = (await (await get(app, `/recv?token=${tc}&wait=0`)).json()) as {
                events: Record<string, unknown>[]
            }
            const aMsgs = body.events.filter((e) => e.type === "message" && e.from === "peer-1")
            expect(aMsgs.map((m) => (m.message as { seq: number }).seq)).toEqual([1, 2])
            expect(aMsgs.map((m) => m.id)).toEqual([3, 6])
            expect(aMsgs.map((m) => (m.message as { body: string }).body)).toEqual(["ping", "pong"])
            const p2Presence = body.events.filter((e) => e.peer === "peer-2").map((e) => e.id)
            expect(p2Presence).toEqual([2, 4, 5])
        })
    })

    // -- heartbeat --------------------------------------------------------

    context("heartbeat", () => {
        it("a lone peer's wait=0 recv is an empty-but-alive heartbeat", async () => {
            const { app } = makeApp()
            const t1 = await jackin(app)
            const r = await get(app, `/recv?token=${t1}&wait=0`)
            expect(r.status).toBe(200)
            const body = (await r.json()) as {
                events: unknown[]
                present_peers: string[]
                read_your_last_message: string[]
                quiet_for: number | null
            }
            expect(body.events).toEqual([])
            expect(body.present_peers).toEqual(["peer-1"])
            expect(body.read_your_last_message).toEqual([])
            expect(body.quiet_for).toBeNull()
        })

        it("quiet_for is 0 right after a message", async () => {
            const { app } = makeApp()
            const t1 = await jackin(app)
            const t2 = await jackin(app)
            await get(app, `/recv?token=${t2}&wait=0`) // drain peer-1's join
            await post(app, `/send?token=${t1}`, "hello peer-2")
            const body = (await (await get(app, `/recv?token=${t2}&wait=0`)).json()) as {
                quiet_for: number | null
                present_peers: string[]
            }
            expect(body.quiet_for).toBe(0)
            expect(new Set(body.present_peers)).toEqual(new Set(["peer-1", "peer-2"]))
        })
    })

    // -- /schema is honest and self-explaining ----------------------------

    context("/schema honesty", () => {
        const schemaDoc = async (
            app: { fetch: (r: Request) => Response | Promise<Response> }
            // biome-ignore lint/suspicious/noExplicitAny: doc is a loose OpenAPI object
        ): Promise<any> => (await (await get(app, "/schema")).json()) as any

        it("documents the raw-text /send body", async () => {
            const { app } = makeApp()
            const doc = await schemaDoc(app)
            const rb = doc.paths["/send"].post.requestBody
            expect(rb.required).toBe(true)
            expect("text/plain" in rb.content).toBe(true)
            expect(rb.content["text/plain"].schema.type).toBe("string")
            expect(rb.description).toContain("@peer")
        })

        it("marks the credentials required (doc only)", async () => {
            const { app } = makeApp()
            const doc = await schemaDoc(app)
            const required = (path: string, method: string, name: string): boolean => {
                const params = doc.paths[path][method].parameters ?? []
                // biome-ignore lint/suspicious/noExplicitAny: param objects are loose
                const p = params.find((q: any) => q.name === name && q.in === "query")
                if (p === undefined) {
                    throw new Error(`${name} param missing on ${method} ${path}`)
                }
                return p.required === true
            }
            expect(required("/jackin", "post", "secret")).toBe(true)
            expect(required("/shard", "get", "secret")).toBe(true)
            expect(required("/send", "post", "token")).toBe(true)
            expect(required("/recv", "get", "token")).toBe(true)
            expect(required("/jackout", "post", "token")).toBe(true)
        })

        it("documents the optional /jackin name param with the <name>-<n> scheme", async () => {
            const { app } = makeApp()
            const doc = await schemaDoc(app)
            const params = doc.paths["/jackin"].post.parameters ?? []
            // biome-ignore lint/suspicious/noExplicitAny: param objects are loose
            const name = params.find((p: any) => p.name === "name" && p.in === "query")
            expect(name).toBeDefined()
            expect(name.required ?? false).toBe(false)
            expect(name.description).toContain("<name>-<n>")
        })

        it("gated routes document a 401, and the descriptions name the codes", async () => {
            const { app } = makeApp()
            const doc = await schemaDoc(app)
            for (const [path, method] of [
                ["/shard", "get"],
                ["/jackin", "post"],
                ["/send", "post"],
                ["/recv", "get"],
                ["/jackout", "post"]
            ] as [string, string][]) {
                expect("401" in doc.paths[path][method].responses).toBe(true)
            }
            const desc = (path: string, method: string): string => doc.paths[path][method].responses["401"].description
            expect(desc("/jackin", "post")).toContain("invalid_secret")
            expect(desc("/shard", "get")).toContain("invalid_secret")
            for (const [path, method] of [
                ["/send", "post"],
                ["/recv", "get"],
                ["/jackout", "post"]
            ] as [string, string][]) {
                expect(desc(path, method)).toContain("invalid_token")
                expect(desc(path, method)).not.toContain("dead_token")
            }
        })

        it("the plain routes document a 200 success body", async () => {
            const { app } = makeApp()
            const doc = await schemaDoc(app)
            // /send returns JSON shaped by SendResponse (a component $ref).
            const send200 = doc.paths["/send"].post.responses["200"]
            expect(send200).toBeDefined()
            expect(send200.content["application/json"].schema.$ref).toBe("#/components/schemas/SendResponse")
            // /shard is markdown, /spectate is an SSE stream.
            expect("text/markdown" in doc.paths["/shard"].get.responses["200"].content).toBe(true)
            expect("text/event-stream" in doc.paths["/spectate"].get.responses["200"].content).toBe(true)
            // SendResponse is in components, with its field descriptions intact.
            const sendResponse = doc.components.schemas.SendResponse
            expect(sendResponse).toBeDefined()
            expect(new Set(Object.keys(sendResponse.properties))).toEqual(
                new Set(["id", "seq", "behind_by", "present_peers"])
            )
            expect(sendResponse.properties.behind_by.description).toBeTruthy()
        })

        it("carries route + field descriptions, incl. the semantics-bearing ones", async () => {
            const { app } = makeApp()
            const doc = await schemaDoc(app)
            for (const [path, method] of [
                ["/health", "get"],
                ["/shard", "get"],
                ["/jackin", "post"],
                ["/jackout", "post"],
                ["/send", "post"],
                ["/recv", "get"]
            ] as [string, string][]) {
                expect(doc.paths[path][method].description).toBeTruthy()
            }
            // biome-ignore lint/suspicious/noExplicitAny: param objects are loose
            const wait = doc.paths["/recv"].get.parameters.find((p: any) => p.name === "wait")
            expect(wait.description).toBeTruthy()
            const schemas = doc.components.schemas
            expect(schemas.JackinResponse.properties.you_are.description).toBeTruthy()
            expect(schemas.MessageEvent.properties.from.description).toBeTruthy()
            expect(schemas.PresenceEvent.properties.peer.description).toBeTruthy()
            expect(schemas.PresenceEvent.properties.type.description).toBeTruthy()
            expect(schemas.RecvResponse.properties.events.description).toContain("type")
            const rylm = schemas.RecvResponse.properties.read_your_last_message.description
            expect(rylm).toContain("read-cursor")
            expect(rylm).toContain("receipt")
        })
    })

    // -- public URL: the decoupled tunnel seam ----------------------------

    context("public URL", () => {
        it("jackin actions are built against public_url, not the request base", async () => {
            const { app } = makeApp({ publicUrl: PUBLIC_URL })
            const body = (await (await post(app, `/jackin?secret=${SECRET}`)).json()) as {
                token: string
                actions: { url: string }[]
            }
            for (const action of body.actions) {
                expect(action.url.startsWith(PUBLIC_URL)).toBe(true)
                expect(action.url).not.toContain("testserver")
            }
            const [sendAction, recvAction] = body.actions
            expect(sendAction?.url).toBe(`${PUBLIC_URL}/send?token=${body.token}`)
            expect(recvAction?.url).toBe(`${PUBLIC_URL}/recv?token=${body.token}`)
        })

        it("with no public_url, jackin actions fall back to the request base", async () => {
            const { app } = makeApp()
            const body = (await (await post(app, `/jackin?secret=${SECRET}`)).json()) as { actions: { url: string }[] }
            for (const action of body.actions) {
                expect(action.url.startsWith(BASE)).toBe(true)
            }
        })
    })

    // -- /spectate: 401 before the stream ---------------------------------

    context("/spectate auth", () => {
        it("wrong secret -> 401 JSON before any stream bytes", async () => {
            const { app } = makeApp()
            const r = await get(app, "/spectate?secret=wrong")
            expect(r.status).toBe(401)
            expect(await r.json()).toEqual({ detail: "invalid secret", code: "invalid_secret" })
            expect((r.headers.get("content-type") ?? "").startsWith("text/event-stream")).toBe(false)
        })

        it("missing secret -> 401 JSON before any stream bytes", async () => {
            const { app } = makeApp()
            const r = await get(app, "/spectate")
            expect(r.status).toBe(401)
            expect(await r.json()).toEqual({ detail: "invalid secret", code: "invalid_secret" })
            expect((r.headers.get("content-type") ?? "").startsWith("text/event-stream")).toBe(false)
        })
    })

    // -- /spectate: the SSE stream ----------------------------------------

    context("/spectate stream", () => {
        it("opens 200 text/event-stream with a snapshot frame (roster + quiet_for)", async () => {
            const { app, room } = makeApp()
            await room.jackin() // peer-1, so the snapshot roster is meaningful
            const { status, contentType, frames } = await collectFrames(app, 1)
            expect(status).toBe(200)
            expect(contentType.startsWith("text/event-stream")).toBe(true)
            const snap = frames[0] as Frame
            expect(snap.event).toBe("snapshot")
            expect(snap.id).toBeNull()
            const data = snap.data as Record<string, unknown>
            expect(new Set(Object.keys(data))).toEqual(new Set(["present_peers", "quiet_for"]))
            expect(data.present_peers).toEqual(["peer-1"])
            expect(data.quiet_for).toBeNull()
        })

        it("emits join then message frames: short event name vs full data.type", async () => {
            const { app, room } = makeApp()
            await room.jackin() // peer-1, present before the spectator opens
            const { frames } = await collectFrames(app, 3, {
                afterOpen: async () => {
                    const [t2] = await room.jackin() // join id 2
                    await room.send(t2, "hello peer-2") // message id 3
                }
            })
            const [snap, join, msg] = frames as [Frame, Frame, Frame]
            expect(snap.event).toBe("snapshot")

            // the join frame: short "join" event name, full "action(join)" data.type
            expect(join.event).toBe("join")
            const jd = join.data as Record<string, unknown>
            expect(jd.type).toBe("action(join)")
            expect(join.event).not.toBe(jd.type)
            expect(join.id).toBe(2)
            expect(join.id).toBe(jd.id as number)
            expect(new Set(Object.keys(jd))).toEqual(new Set(["id", "type", "peer", "sent_at"]))
            expect(jd.peer).toBe("peer-2")
            expect(ISO_UTC_Z_RE.test(jd.sent_at as string)).toBe(true)

            // the message frame, equal to what /recv emits for that entry
            expect(msg.event).toBe("message")
            const md = msg.data as Record<string, unknown>
            expect(md.type).toBe("message")
            expect(msg.id).toBe(3)
            expect(msg.id).toBe(md.id as number)
            expect({ id: md.id, type: md.type, from: md.from, message: md.message }).toEqual({
                id: 3,
                type: "message",
                from: "peer-2",
                message: { seq: 1, body: "hello peer-2" }
            })
            expect("peer" in md).toBe(false)
            expect(ISO_UTC_Z_RE.test(md.sent_at as string)).toBe(true)
        })

        it("emits a leave frame (short name vs full data.type)", async () => {
            const { app, room } = makeApp()
            await room.jackin() // peer-1
            const [t2] = await room.jackin() // peer-2, join id 2
            const { frames } = await collectFrames(app, 2, {
                afterOpen: async () => {
                    await room.jackout(t2) // leave id 3
                }
            })
            const [snap, leave] = frames as [Frame, Frame]
            expect(snap.event).toBe("snapshot")
            expect(leave.event).toBe("leave")
            const ld = leave.data as Record<string, unknown>
            expect(ld.type).toBe("action(leave)")
            expect(leave.event).not.toBe(ld.type)
            expect(leave.id).toBe(3)
            expect(new Set(Object.keys(ld))).toEqual(new Set(["id", "type", "peer", "sent_at"]))
            expect(ld.peer).toBe("peer-2")
        })

        it("frames carry the right fields: snapshot has event+data (no id), an event frame adds id", async () => {
            // SSE fields are a SET, not a sequence (line order is not significant
            // per spec), so assert on the field VALUES rather than an exact byte
            // ordering: the snapshot has event+data and NO id; a live event frame
            // carries id+event+data. Each frame is still a valid, blank-line-
            // terminated SSE frame with exactly one data: line (parseFrame asserts).
            const { app, room } = makeApp()
            await room.jackin() // peer-1
            const resp = await Promise.resolve(
                app.fetch(new Request(`${BASE}/spectate?secret=${SECRET}`, { method: "GET" }))
            )
            const reader = (resp.body as ReadableStream<Uint8Array>).getReader()
            const decoder = new TextDecoder()
            let buf = ""
            try {
                // Drain bytes until we have the snapshot + one event frame, each
                // properly terminated by a blank line (so split("\n\n") yields
                // two complete frames plus a trailing remainder).
                const deadline = Date.now() + 5000
                let droveEvent = false
                while (buf.split("\n\n").length < 3 && Date.now() < deadline) {
                    const { done, value } = await reader.read()
                    if (done) {
                        break
                    }
                    buf += decoder.decode(value, { stream: true })
                    if (!droveEvent && buf.includes("\n\n")) {
                        droveEvent = true
                        await room.jackin() // a live join -> one event frame
                    }
                }
                const [snapRaw, eventRaw] = buf.split("\n\n") as [string, string]
                // Every frame ends with a blank line: the raw stream contains the
                // "\n\n" delimiters that split() consumed between frames.
                expect(buf.startsWith(`${snapRaw}\n\n${eventRaw}\n\n`)).toBe(true)
                // Snapshot frame: event+data fields, NO id (live-only start cursor).
                const snap = parseFrame(snapRaw)
                expect(snap.event).toBe("snapshot")
                expect(snap.id).toBe(null)
                expect(snap.data).not.toBe(null)
                expect(snapRaw.includes("id:")).toBe(false)
                // Event frame: id+event+data fields (id present so a reconnect can resume).
                const event = parseFrame(eventRaw)
                expect(event.event).toBe("join")
                expect(typeof event.id).toBe("number")
                expect(event.data).not.toBe(null)
            } finally {
                await reader.cancel().catch(() => {})
            }
        })
    })

    // -- /spectate: heartbeat ---------------------------------------------

    context("/spectate heartbeat", () => {
        // The heartbeat is a 15s module constant; we can't easily shorten it from
        // the test, but we can prove the snapshot path and the LIVE-replay paths
        // below cover the same roster frame. The heartbeat shape is exercised via
        // the room.spectateRoster() unit tests in room.spec.ts; here we assert the
        // snapshot (same payload shape the heartbeat reuses) carries quiet_for.
        it("the snapshot reports quiet_for as an int after a message", async () => {
            const { app, room } = makeApp()
            const [t1] = await room.jackin()
            await room.jackin() // peer-2
            await room.send(t1, "spoke just now")
            const { frames } = await collectFrames(app, 1)
            const snap = frames[0] as Frame
            const data = snap.data as Record<string, unknown>
            expect(new Set(data.present_peers as string[])).toEqual(new Set(["peer-1", "peer-2"]))
            expect(typeof data.quiet_for).toBe("number")
        })
    })

    // -- /spectate: Last-Event-ID replay ----------------------------------

    context("/spectate Last-Event-ID", () => {
        // Seed: peer-1 join(1), peer-2 join(2), message(3), peer-2 leave(4). Max 4.
        const seedBacklog = async (room: {
            jackin: () => Promise<[string, string]>
            send: (t: string, s: string) => Promise<unknown>
            jackout: (t: string) => Promise<string>
        }): Promise<void> => {
            await room.jackin() // id 1
            const [t2] = await room.jackin() // id 2
            await room.send(t2, "backlog msg") // id 3
            await room.jackout(t2) // id 4
        }

        it("replays only events past the header id", async () => {
            const { app, room } = makeApp()
            await seedBacklog(room)
            expect(room.eventId).toBe(4)
            const { frames } = await collectFrames(app, 3, { headers: { "Last-Event-ID": "2" } })
            const parsed = frames
            expect(parsed[0]?.event).toBe("snapshot")
            expect(parsed.slice(1).map((p) => [p.event, p.id])).toEqual([
                ["message", 3],
                ["leave", 4]
            ])
        })

        it("Last-Event-ID 0 replays the whole backlog", async () => {
            const { app, room } = makeApp()
            await seedBacklog(room)
            const { frames } = await collectFrames(app, 5, { headers: { "Last-Event-ID": "0" } })
            expect(frames[0]?.event).toBe("snapshot")
            expect(frames.slice(1).map((p) => [p.event, p.id])).toEqual([
                ["join", 1],
                ["join", 2],
                ["message", 3],
                ["leave", 4]
            ])
        })

        it.each([
            ["garbage", "not-a-number"],
            ["negative", "-5"],
            ["future", "99999"]
        ] as [string, string][])("a %s Last-Event-ID clamps to max (no replay, starts live)", async (_label, value) => {
            const { app, room } = makeApp()
            await seedBacklog(room)
            const { frames } = await collectFrames(app, 2, {
                headers: { "Last-Event-ID": value },
                // No backlog replays, so the second frame only arrives on a live
                // event — drive one so we don't wait 15s for a heartbeat.
                afterOpen: async () => {
                    const [t3] = await room.jackin() // a fresh live join (id 5)
                    void t3
                }
            })
            expect(frames[0]?.event).toBe("snapshot")
            // The second frame is the LIVE join (id 5), proving no backlog replayed.
            expect(frames[1]?.event).toBe("join")
            expect(frames[1]?.id).toBe(5)
        })

        it("a missing Last-Event-ID starts live (no backlog)", async () => {
            const { app, room } = makeApp()
            await seedBacklog(room)
            const { frames } = await collectFrames(app, 2, {
                afterOpen: async () => {
                    await room.jackin() // live join id 5
                }
            })
            expect(frames[0]?.event).toBe("snapshot")
            expect(frames[1]?.event).toBe("join")
            expect(frames[1]?.id).toBe(5)
        })
    })

    // -- /spectate: invisibility ------------------------------------------

    context("/spectate invisibility", () => {
        it("a spectator never appears in present_peers and mints no peer", async () => {
            const { app, room } = makeApp()
            const { frames } = await collectFrames(app, 1)
            const snap = frames[0] as Frame
            expect(snap.event).toBe("snapshot")
            expect((snap.data as Record<string, unknown>).present_peers).toEqual([])
            expect(room.peers()).toEqual([])
        })

        it("a parked spectator does not block the empty-room self-close", async () => {
            // The invisibility invariant's teeth: a spectator holding the stream
            // OPEN (parked on room.cond) touches neither the roster nor last_active,
            // so the empty room still self-closes. Driven on the clock seam
            // (far-future) so no real grace elapses; sweepInterval tiny so the live
            // reaper ticks promptly.
            const clock = fakeClock()
            const { app, room, startReaper } = createApp(
                cfg({ emptyGrace: 900, idleTimeout: 0, sweepInterval: 0.05 }),
                clock
            )
            clock.now = 1e9 // boot-armed empty room is instantly past grace

            // Open the stream and read its snapshot, then KEEP it open (don't cancel
            // the reader) so the spectator stays genuinely parked while we decide.
            const resp = await Promise.resolve(
                app.fetch(new Request(`${BASE}/spectate?secret=${SECRET}`, { method: "GET" }))
            )
            expect(resp.status).toBe(200)
            const reader = (resp.body as ReadableStream<Uint8Array>).getReader()
            try {
                const first = await reader.read()
                const raw = new TextDecoder().decode(first.value).split("\n\n")[0] as string
                const snap = parseFrame(raw)
                expect((snap.data as Record<string, unknown>).present_peers).toEqual([])

                // The empty-room decision fires DESPITE the parked spectator.
                expect(await room.shouldSelfClose()).toBe(true)

                // The live reaper calls the hook exactly once while the spectator is
                // still parked, then self-stops.
                const fired: number[] = []
                const stop = startReaper(() => fired.push(1))
                const deadline = Date.now() + 5000
                while (fired.length === 0 && Date.now() < deadline) {
                    await new Promise((r) => setTimeout(r, 5))
                }
                stop()
                expect(fired).toEqual([1])
            } finally {
                await reader.cancel().catch(() => {})
            }
        })
    })

    // -- the reaper: start-gate + self-close hook -------------------------

    context("reaper start-gate", () => {
        it("idle drop + empty close both off -> no sweeper, no self-close", async () => {
            const clock = fakeClock()
            const { room, startReaper } = createApp(cfg({ idleTimeout: 0, emptyGrace: 0 }), clock)
            const fired: number[] = []
            const stop = startReaper(() => fired.push(1))
            await room.jackin()
            clock.now = 1e9
            await new Promise((r) => setTimeout(r, 100))
            expect(room.peers()).toContain("peer-1") // never dropped
            expect(fired).toEqual([]) // never self-closed
            stop()
        })

        it("idle on, empty off -> a silent peer is reaped; the hook never fires", async () => {
            const clock = fakeClock()
            const { room, startReaper } = createApp(
                cfg({ idleTimeout: 2, waitDefault: 1, waitMax: 1, sweepInterval: 0.05, emptyGrace: 0 }),
                clock
            )
            const fired: number[] = []
            const stop = startReaper(() => fired.push(1))
            await room.jackin()
            expect(room.peers()).toContain("peer-1")
            clock.now = 1e9 // every existing peer now looks idle
            const deadline = Date.now() + 5000
            while (room.peers().includes("peer-1") && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 10))
            }
            expect(room.peers()).not.toContain("peer-1")
            expect(fired).toEqual([]) // empty_grace==0 -> self-close disabled
            stop()
        })

        it("idle off, empty on -> the room self-closes (the hook fires exactly once)", async () => {
            const clock = fakeClock()
            const { startReaper } = createApp(cfg({ idleTimeout: 0, emptyGrace: 900, sweepInterval: 0.05 }), clock)
            clock.now = 1e9 // boot-armed empty room is instantly past grace
            const fired: number[] = []
            const stop = startReaper(() => fired.push(1))
            const deadline = Date.now() + 5000
            while (fired.length === 0 && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 10))
            }
            // Give it a moment to (wrongly) fire again — it must not.
            await new Promise((r) => setTimeout(r, 100))
            expect(fired).toEqual([1])
            stop()
        })

        it("a populated room never self-closes", async () => {
            const clock = fakeClock()
            const { room, startReaper } = createApp(
                cfg({ idleTimeout: 0, emptyGrace: 900, sweepInterval: 0.05 }),
                clock
            )
            await room.jackin() // occupy -> never empty
            clock.now = 1e9
            const fired: number[] = []
            const stop = startReaper(() => fired.push(1))
            await new Promise((r) => setTimeout(r, 200))
            expect(fired).toEqual([])
            stop()
        })

        it("an empty room not yet past grace does not self-close", async () => {
            const clock = fakeClock() // starts at 1000; the room boot-arms emptySince=1000
            const { startReaper } = createApp(cfg({ idleTimeout: 0, emptyGrace: 900, sweepInterval: 0.05 }), clock)
            clock.now = 1010 // only +10s elapsed, well under the 900s grace
            const fired: number[] = []
            const stop = startReaper(() => fired.push(1))
            await new Promise((r) => setTimeout(r, 200))
            expect(fired).toEqual([])
            stop()
        })
    })

    // -- the live reaper end to end over HTTP -----------------------------

    context("idle reaper over HTTP", () => {
        it("drops a silent peer, the leave is observable, and the token stays immortal", async () => {
            const clock = fakeClock()
            const { app, room, startReaper } = createApp(
                cfg({ idleTimeout: 2, waitDefault: 1, waitMax: 1, sweepInterval: 0.05 }),
                clock
            )
            const stop = startReaper(() => {})
            const t1 = await jackin(app)
            expect(room.peers()).toContain("peer-1")
            clock.now = 1e9 // every peer now looks idle
            const deadline = Date.now() + 5000
            while (room.peers().includes("peer-1") && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 10))
            }
            expect(room.peers()).not.toContain("peer-1")

            // The drop is observable as an action(leave). A fresh observer is
            // stamped at the far-future clock, so it survives the same sweep.
            const tObs = await jackin(app)
            const body = (await (await get(app, `/recv?token=${tObs}&wait=0`)).json()) as {
                events: Record<string, unknown>[]
            }
            const leaves = body.events.filter((e) => e.type === "action(leave)" && e.peer === "peer-1")
            expect(leaves.length).toBeGreaterThan(0)
            // peer-1's token is immortal — a later call rejoins, never 401s.
            expect((await get(app, `/recv?token=${t1}&wait=0`)).status).toBe(200)
            stop()
        })

        it("the full idle-drop -> rejoin story over the wire keeps the name and never 401s", async () => {
            const clock = fakeClock()
            const { app, room, startReaper } = createApp(
                cfg({ idleTimeout: 2, waitDefault: 1, waitMax: 1, sweepInterval: 0.05 }),
                clock
            )
            const stop = startReaper(() => {})
            const r = await post(app, `/jackin?secret=${SECRET}&name=alice`)
            const aliceBody = (await r.json()) as { token: string; you_are: string }
            const tAlice = aliceBody.token
            expect(aliceBody.you_are).toBe("alice-1")

            // an observer to witness alice's leave/rejoin on the shared stream
            const bobBody = (await (await post(app, `/jackin?secret=${SECRET}&name=bob`)).json()) as { token: string }
            const tBob = bobBody.token
            await get(app, `/recv?token=${tBob}&wait=0`) // drain alice's join

            expect((await get(app, `/recv?token=${tAlice}&wait=0`)).status).toBe(200)
            expect(room.peers()).toContain("alice-1")

            clock.now = 1e9
            const deadline = Date.now() + 5000
            while (room.peers().includes("alice-1") && Date.now() < deadline) {
                await new Promise((res) => setTimeout(res, 10))
            }
            expect(room.peers()).not.toContain("alice-1")

            // same token /send -> must not 401, and rejoins alice with the SAME name
            const sendR = await post(app, `/send?token=${tAlice}`, "i'm back")
            expect(sendR.status).toBe(200)
            expect(room.peers()).toContain("alice-1")
            expect(room.peerNameFor(tAlice)).toBe("alice-1")

            // every gated endpoint still accepts the immortal token
            expect((await get(app, `/recv?token=${tAlice}&wait=0`)).status).toBe(200)
            expect((await post(app, `/send?token=${tAlice}`, "still here")).status).toBe(200)
            expect((await post(app, `/jackout?token=${tAlice}`)).status).toBe(200)
            stop()
        })
    })
})
