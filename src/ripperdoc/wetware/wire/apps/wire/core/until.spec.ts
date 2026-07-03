/**
 * until.spec.ts — the optional `until=<predicates>` return-trigger on /recv.
 *
 * `until` gates only WHEN recv returns, never what it returns or the cursor
 * advance. Most cases drive the room core directly (deterministic, no HTTP) —
 * event predicates on the real clock with tiny waits, and `idle:<sec>` on a
 * `fakeClock` so quiet_for is exact with zero real sleeping. A couple of HTTP
 * cases prove the query param plumbs through and /schema documents it, plus one
 * real-clock case proves idle actually fires through the park loop.
 */

import { describe, expect, it } from "bun:test"
import { createApp } from "./app"
import { type FakeClock, fakeClock } from "./clock"
import { type Config, makeConfig } from "./config"
import { type LogEntry, type Message, makeRoom, type Room } from "./room"

const context = describe

/** A room on the real clock with tiny waits — for the event-based predicates. */
const makeTestRoom = (): Room =>
    makeRoom(makeConfig({ host: "127.0.0.1", port: 0, secret: "s3cr3t", topic: "t", waitDefault: 0.05, waitMax: 0.2 }))

/** A room on the real clock with a multi-second wait cap — for real-time idle firing. */
const makeSlowRoom = (): Room =>
    makeRoom(
        makeConfig({
            host: "127.0.0.1",
            port: 0,
            secret: "s3cr3t",
            topic: "t",
            waitDefault: 0.05,
            waitMax: 2,
            idleTimeout: 5
        })
    )

/** A room on a controllable clock — for exact quiet_for in the idle cases. */
const fakeRoom = (): { room: Room; clock: FakeClock } => {
    const clock = fakeClock()
    const cfg = makeConfig({
        host: "127.0.0.1",
        port: 0,
        secret: "s3cr3t",
        topic: "t",
        waitDefault: 0.05,
        waitMax: 0.2,
        idleTimeout: 10
    })
    return { room: makeRoom(cfg, clock), clock }
}

/** Message bodies from a recv batch, in order (the log interleaves presence). */
const messageBodies = (events: LogEntry[]): string[] =>
    events.filter((e): e is Message => e.type === "message").map((e) => e.message)

describe("recv until=<predicates>", () => {
    // -- absent until: unchanged from today ------------------------------------

    context("absent until", () => {
        it("returns on any new event, exactly like today's /recv", async () => {
            const room = makeTestRoom()
            const [t1] = await room.jackin()
            const [t2] = await room.jackin()
            await room.recv(t2, 0) // drain peer-1's join
            await room.send(t1, "hi")
            const out = await room.recv(t2, 0.2) // no until argument
            expect(messageBodies(out.events)).toEqual(["hi"])
            // a bare join (no message) also returns, as today
            await room.jackin() // peer-3
            const out2 = await room.recv(t2, 0.2)
            expect(out2.events.some((e) => e.type === "action(join)")).toBe(true)
        })
    })

    // -- mentions:me ----------------------------------------------------------

    context("until=mentions:me", () => {
        it("holds on non-mentions and fires on a mention, delivering ALL unread", async () => {
            const room = makeTestRoom()
            const [t1] = await room.jackin() // peer-1
            const [t2] = await room.jackin() // peer-2
            await room.recv(t2, 0) // drain peer-1's join
            // A non-mention message must NOT fire -> heartbeat, message held unread.
            await room.send(t1, "general chatter")
            const held = await room.recv(t2, 0.05, "mentions:me")
            expect(held.events).toEqual([])
            // A mention fires and returns the mention AND the piled-up chatter.
            await room.send(t1, "@peer-2 you around?")
            const out = await room.recv(t2, 0.2, "mentions:me")
            expect(messageBodies(out.events)).toEqual(["general chatter", "@peer-2 you around?"])
        })

        it("ignores a mention of a DIFFERENT peer", async () => {
            const room = makeTestRoom()
            const [t1] = await room.jackin() // peer-1
            const [t2] = await room.jackin() // peer-2
            await room.jackin() // peer-3
            await room.recv(t2, 0) // drain joins
            await room.send(t1, "@peer-3 ping") // mentions peer-3, not peer-2
            expect((await room.recv(t2, 0.05, "mentions:me")).events).toEqual([])
            await room.send(t1, "@peer-2 ping")
            const out = await room.recv(t2, 0.2, "mentions:me")
            expect(messageBodies(out.events)).toEqual(["@peer-3 ping", "@peer-2 ping"])
        })

        it("does not fire on a near-name (@peer-2 does not match @peer-20)", async () => {
            const room = makeTestRoom()
            const [t1] = await room.jackin() // peer-1
            const [t2] = await room.jackin() // peer-2
            await room.recv(t2, 0)
            await room.send(t1, "paging @peer-20 not you")
            expect((await room.recv(t2, 0.05, "mentions:me")).events).toEqual([])
        })
    })

    // -- message / join / leave ----------------------------------------------

    context("event-type predicates", () => {
        it("until=message fires on a chat message but not on a bare join", async () => {
            const room = makeTestRoom()
            const [t1] = await room.jackin() // peer-1
            const [t2] = await room.jackin() // peer-2
            await room.recv(t2, 0) // drain
            await room.jackin() // peer-3 joins (presence, not a message)
            expect((await room.recv(t2, 0.05, "message")).events).toEqual([])
            await room.send(t1, "hello")
            const out = await room.recv(t2, 0.2, "message")
            expect(messageBodies(out.events)).toEqual(["hello"])
            expect(out.events.some((e) => e.type === "action(join)")).toBe(true) // piled-up join rides along
        })

        it("until=join fires when a peer joins, bundling any piled-up message", async () => {
            const room = makeTestRoom()
            const [t1] = await room.jackin() // peer-1
            const [t2] = await room.jackin() // peer-2
            await room.recv(t2, 0) // drain
            await room.send(t1, "hi")
            expect((await room.recv(t2, 0.05, "join")).events).toEqual([]) // a message alone can't fire join
            await room.jackin() // peer-3 joins
            const out = await room.recv(t2, 0.2, "join")
            expect(out.events.some((e) => e.type === "action(join)")).toBe(true)
            expect(messageBodies(out.events)).toEqual(["hi"]) // held message delivered too
        })
    })

    // -- no silent drop -------------------------------------------------------

    context("no silent drop", () => {
        it("a heartbeat under until leaves unread queued for a later plain recv", async () => {
            const room = makeTestRoom()
            const [t1] = await room.jackin()
            const [t2] = await room.jackin()
            await room.recv(t2, 0)
            await room.send(t1, "noise") // unread, but until=leave can never fire here
            const held = await room.recv(t2, 0.05, "leave")
            expect(held.events).toEqual([])
            // a plain /recv (no until) still delivers the held message — nothing dropped
            const out = await room.recv(t2, 0)
            expect(messageBodies(out.events)).toEqual(["noise"])
        })
    })

    // -- idle:<sec> -----------------------------------------------------------

    context("until=idle:<sec>", () => {
        it("holds until the room is quiet >= N seconds, then delivers held unread", async () => {
            const { room, clock } = fakeRoom()
            const [t1] = await room.jackin()
            const [t2] = await room.jackin()
            await room.recv(t2, 0) // drain join
            await room.send(t1, "something") // lastMsgAt = 1000, quiet_for = 0
            // quiet_for 0 < 5 -> idle:5 does not fire -> heartbeat, message held
            expect((await room.recv(t2, 0.05, "idle:5")).events).toEqual([])
            // advance past the threshold; now idle:5 fires and delivers the held message
            clock.now += 5
            const out = await room.recv(t2, 0.05, "idle:5")
            expect(messageBodies(out.events)).toEqual(["something"])
            expect(out.quietFor).toBe(5)
        })

        it("heartbeats when no message has ever been sent (quiet_for is null)", async () => {
            const { room } = fakeRoom()
            await room.jackin()
            const [t2] = await room.jackin()
            await room.recv(t2, 0) // drain join; no chat yet -> quiet_for null
            const hb = await room.recv(t2, 0.05, "idle:1")
            expect(hb.events).toEqual([])
            expect(hb.quietFor).toBeNull()
        })

        it("actually fires through the park loop once the room goes quiet (real clock)", async () => {
            const room = makeSlowRoom()
            const [t1] = await room.jackin()
            const [t2] = await room.jackin()
            await room.recv(t2, 0)
            await room.send(t1, "held") // quiet_for starts at 0
            // idle:1 with a 2s budget: parks, wakes ~1s later once quiet_for hits 1, fires.
            const out = await room.recv(t2, 3, "idle:1")
            expect(messageBodies(out.events)).toEqual(["held"])
            expect(out.quietFor).toBeGreaterThanOrEqual(1)
        })
    })

    // -- unknown / malformed predicates --------------------------------------

    context("graceful degradation", () => {
        it("an all-unknown/malformed until degrades to a normal recv", async () => {
            const room = makeTestRoom()
            const [t1] = await room.jackin()
            const [t2] = await room.jackin()
            await room.recv(t2, 0)
            await room.send(t1, "hi")
            // "mention" (not mentions:me), "idle:abc" (NaN), "bogus" — none valid
            const out = await room.recv(t2, 0.2, "bogus,idle:abc,mention")
            expect(messageBodies(out.events)).toEqual(["hi"])
        })

        it("drops only the invalid predicate from a mixed list", async () => {
            const room = makeTestRoom()
            const [t1] = await room.jackin()
            const [t2] = await room.jackin()
            await room.recv(t2, 0)
            await room.send(t1, "plain") // a message; until=message,bogus should still fire on it
            const out = await room.recv(t2, 0.2, "bogus,message")
            expect(messageBodies(out.events)).toEqual(["plain"])
        })
    })

    // -- HTTP plumbing + /schema ---------------------------------------------

    context("over HTTP", () => {
        const SECRET = "s3cret"
        const BASE = "http://testserver"
        type App = { fetch: (r: Request) => Response | Promise<Response> }
        const makeApp = (overrides: Partial<Config> = {}) =>
            createApp(makeConfig({ host: "127.0.0.1", port: 0, secret: SECRET, topic: "t", ...overrides }))
        const get = (app: App, path: string): Promise<Response> =>
            Promise.resolve(app.fetch(new Request(`${BASE}${path}`, { method: "GET" })))
        const post = (app: App, path: string, body?: string): Promise<Response> =>
            Promise.resolve(app.fetch(new Request(`${BASE}${path}`, { method: "POST", body })))
        const jackin = async (app: App): Promise<string> => {
            const r = await post(app, `/jackin?secret=${SECRET}`)
            expect(r.status).toBe(200)
            return ((await r.json()) as { token: string }).token
        }

        it("GET /recv?until=mentions:me heartbeats on noise, returns on the mention", async () => {
            const { app } = makeApp()
            const t1 = await jackin(app)
            const t2 = await jackin(app)
            await get(app, `/recv?token=${t2}&wait=0`) // drain
            await post(app, `/send?token=${t1}`, "background noise")
            const hb = (await (await get(app, `/recv?token=${t2}&wait=0&until=mentions:me`)).json()) as {
                events: Record<string, unknown>[]
            }
            expect(hb.events).toEqual([]) // noise held, no mention yet
            await post(app, `/send?token=${t1}`, "@peer-2 ping")
            const out = (await (await get(app, `/recv?token=${t2}&wait=0&until=mentions:me`)).json()) as {
                events: Record<string, unknown>[]
            }
            const bodies = out.events
                .filter((e) => e.type === "message")
                .map((e) => (e.message as { body: string }).body)
            expect(bodies).toEqual(["background noise", "@peer-2 ping"])
        })

        it("/schema documents the optional until param on /recv", async () => {
            const { app } = makeApp()
            // biome-ignore lint/suspicious/noExplicitAny: doc is a loose OpenAPI object
            const doc = (await (await get(app, "/schema")).json()) as any
            const params = doc.paths["/recv"].get.parameters ?? []
            // biome-ignore lint/suspicious/noExplicitAny: param objects are loose
            const until = params.find((p: any) => p.name === "until" && p.in === "query")
            expect(until).toBeDefined()
            expect(until.required ?? false).toBe(false)
            expect(until.description).toContain("idle:")
            expect(until.description).toContain("mentions:me")
        })
    })
})
