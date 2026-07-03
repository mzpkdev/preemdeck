/**
 * room.spec.ts — unit tests for the framework-free room core.
 *
 * No HTTP — exercises event-id ordering, the gap-free message seq, per-token
 * cursors, readYourLastMessage, peer naming, jackout/validation status, the
 * long-poll wake, quietFor, idle reap, and empty-room self-close. Real parks are
 * tiny (<=0.2s); all time-logic tests drive a `fakeClock` so nothing sleeps.
 */

import { describe, expect, it } from "bun:test"
import { type FakeClock, fakeClock } from "./clock"
import { makeConfig } from "./config"
import { type LogEntry, type Message, makeRoom, type Presence, type Room } from "./room"

const context = describe

// ISO-8601 UTC, second precision, Z-suffixed: e.g. 2026-06-18T13:57:02Z.
const ISO_UTC_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

/** A room on the real clock with tiny waits, for the non-time-logic cases. */
const makeTestRoom = (overrides: Record<string, number> = {}): Room => {
    const cfg = makeConfig({
        host: "127.0.0.1",
        port: 0,
        secret: "s3cr3t",
        topic: "testing the wire",
        waitDefault: 0.05,
        waitMax: 0.2,
        ...overrides
    })
    return makeRoom(cfg)
}

/** A room on a controllable clock (idle drop on), for reap / quietFor cases. */
const idleRoom = (idleTimeout = 10): { room: Room; clock: FakeClock } => {
    const clock = fakeClock()
    const cfg = makeConfig({
        host: "127.0.0.1",
        port: 0,
        secret: "s3cr3t",
        topic: "testing the wire",
        waitDefault: 0.05,
        waitMax: 0.2,
        idleTimeout
    })
    return { room: makeRoom(cfg, clock), clock }
}

/** A room on a controllable clock with empty-room self-close armed. */
const graceRoom = (emptyGrace = 100, idleTimeout = 10): { room: Room; clock: FakeClock } => {
    const clock = fakeClock()
    const cfg = makeConfig({
        host: "127.0.0.1",
        port: 0,
        secret: "s3cr3t",
        topic: "testing the wire",
        waitDefault: 0.05,
        waitMax: 0.2,
        idleTimeout,
        emptyGrace
    })
    return { room: makeRoom(cfg, clock), clock }
}

/** Message events only, projected to (id, sender). The room log interleaves presence. */
const messageSenders = (events: LogEntry[]): [number, string][] =>
    events.filter((e): e is Message => e.type === "message").map((e) => [e.id, e.sender])

/** Presence events of a given type about a given peer, from the spectator log. */
const presenceAbout = (room: Room, type: Presence["type"], name: string): Presence[] =>
    room.eventsSince(0).filter((e): e is Presence => e.type === type && (e as Presence).peer === name)

describe("Room", () => {
    // -- peer naming & membership --

    context("peer naming", () => {
        it("assigns peer-N in join order when unnamed", async () => {
            const room = makeTestRoom()
            const [t1, n1] = await room.jackin()
            const [t2, n2] = await room.jackin()
            const [t3, n3] = await room.jackin()
            expect([n1, n2, n3]).toEqual(["peer-1", "peer-2", "peer-3"])
            expect(t1 !== t2 && t2 !== t3 && t1 !== t3).toBe(true)
            expect(room.peers()).toEqual(["peer-1", "peer-2", "peer-3"])
        })

        it("assigns a requested name as <base>-1 and reflects it everywhere", async () => {
            const room = makeTestRoom()
            const [t1, n1] = await room.jackin("alice")
            expect(n1).toBe("alice-1")
            expect(room.peers()).toEqual(["alice-1"])
            expect(room.peerNameFor(t1)).toBe("alice-1")
            const [t2] = await room.jackin()
            await room.send(t1, "hi")
            const out = await room.recv(t2, 0)
            expect(messageSenders(out.events)).toEqual([[3, "alice-1"]])
        })

        it("climbs n on a repeated base", async () => {
            const room = makeTestRoom()
            const [, n1] = await room.jackin("alice")
            const [, n2] = await room.jackin("alice")
            const [, n3] = await room.jackin("alice")
            expect([n1, n2, n3]).toEqual(["alice-1", "alice-2", "alice-3"])
        })

        it("numbers per-base: a named peer leaves no gap in the peer-N line", async () => {
            const room = makeTestRoom()
            const [, n1] = await room.jackin("alice")
            const [, n2] = await room.jackin()
            const [, n3] = await room.jackin("bob")
            const [, n4] = await room.jackin()
            expect([n1, n2, n3, n4]).toEqual(["alice-1", "peer-1", "bob-1", "peer-2"])
        })

        it("collides case-insensitively (Alice/alice/ALICE share a base)", async () => {
            const room = makeTestRoom()
            const [, n1] = await room.jackin("Alice")
            const [, n2] = await room.jackin("alice")
            const [, n3] = await room.jackin("ALICE")
            expect([n1, n2, n3]).toEqual(["alice-1", "alice-2", "alice-3"])
        })

        it("keeps a name bound for the room's life — even after jackout", async () => {
            const room = makeTestRoom()
            const [t1, n1] = await room.jackin("alice")
            await room.jackout(t1)
            const [, n2] = await room.jackin("alice")
            expect([n1, n2]).toEqual(["alice-1", "alice-2"])
        })

        it.each([
            ["My Agent", "my-agent-1"],
            ["has space", "has-space-1"],
            ["a@b c!", "ab-c-1"],
            ["a -- b", "a-b-1"],
            ["my_agent", "my-agent-1"],
            ["a@b", "ab-1"],
            ["@alice", "alice-1"],
            ["no/slash", "noslash-1"],
            ["dot.dot", "dotdot-1"],
            ["-x-", "x-1"],
            ["_x_", "x-1"],
            ["", "peer-1"],
            ["@@@", "peer-1"],
            ["   ", "peer-1"],
            ["!!!", "peer-1"]
        ] as [string, string][])("normalizes %p to base %p", async (requested, expected) => {
            const room = makeTestRoom()
            const [, name] = await room.jackin(requested)
            expect(name).toBe(expected)
        })

        it("caps an oversized base to 32 chars before the suffix", async () => {
            const room = makeTestRoom()
            const [, name] = await room.jackin("x".repeat(40))
            expect(name).toBe(`${"x".repeat(32)}-1`)
        })

        it("treats &name=peer as the default base (shares peer-N)", async () => {
            const room = makeTestRoom()
            const [, n1] = await room.jackin()
            const [, n2] = await room.jackin("peer")
            expect([n1, n2]).toEqual(["peer-1", "peer-2"])
        })

        it("treats an already-suffixed request as a verbatim base", async () => {
            const room = makeTestRoom()
            const [, name] = await room.jackin("alice-2")
            expect(name).toBe("alice-2-1")
        })

        it("strips surrounding whitespace and lowercases", async () => {
            const room = makeTestRoom()
            const [, name] = await room.jackin("  Alice  ")
            expect(name).toBe("alice-1")
        })

        it("never produces two same (case-insensitive) names across a churn", async () => {
            const room = makeTestRoom()
            const requests = ["alice", "Alice", "bob", "peer", "x x", null, "bob", "carol", "", null]
            const names: string[] = []
            for (const r of requests) {
                const [, name] = await room.jackin(r)
                names.push(name)
            }
            const folded = names.map((n) => n.toLowerCase())
            expect(folded.length).toBe(new Set(folded).size)
        })

        it("binds a token to one peer for life (name survives jackout)", async () => {
            const room = makeTestRoom()
            const [t1] = await room.jackin()
            expect(room.peerNameFor(t1)).toBe("peer-1")
            await room.jackout(t1)
            expect(room.peerNameFor(t1)).toBe("peer-1")
        })

        it("removes a jacked-out peer from the roster", async () => {
            const room = makeTestRoom()
            const [t1] = await room.jackin()
            await room.jackin()
            const left = await room.jackout(t1)
            expect(left).toBe("peer-1")
            expect(room.peers()).toEqual(["peer-2"])
        })
    })

    // -- token validation surface --

    context("token validation", () => {
        it("reports UNKNOWN for a token never minted", () => {
            const room = makeTestRoom()
            expect(room.status("not-a-real-token")).toBe("unknown")
            expect(room.isKnown("not-a-real-token")).toBe(false)
            expect(room.peerNameFor("not-a-real-token")).toBeNull()
        })

        it("keeps a token VALID after jackout (tokens are immortal)", async () => {
            const room = makeTestRoom()
            const [t1] = await room.jackin()
            expect(room.status(t1)).toBe("valid")
            expect(room.isKnown(t1)).toBe(true)
            await room.jackout(t1)
            expect(room.status(t1)).toBe("valid")
            expect(room.isKnown(t1)).toBe(true)
        })
    })

    // -- seq ordering --

    context("event id vs message seq", () => {
        it("climbs event id across senders while seq stays message-only", async () => {
            // Two joins take id 1,2; the three sends climb 3,4,5. Their seq, untouched
            // by the joins, climbs 1,2,3.
            const room = makeTestRoom()
            const [ta] = await room.jackin()
            const [tb] = await room.jackin()
            const r1 = await room.send(ta, "hi from a")
            const r2 = await room.send(tb, "hi from b")
            const r3 = await room.send(ta, "again from a")
            expect([r1.id, r2.id, r3.id]).toEqual([3, 4, 5])
            expect([r1.seq, r2.seq, r3.seq]).toEqual([1, 2, 3])
        })

        it("keeps message seq contiguous despite interleaved presence", async () => {
            // A joins -> id 1, sends -> id 2/seq 1, B joins -> id 3 (no seq), A sends
            // -> id 4/seq 2. seq is gap-free; ids straddle B's join.
            const room = makeTestRoom()
            const [ta] = await room.jackin()
            const r1 = await room.send(ta, "first")
            await room.jackin()
            const r2 = await room.send(ta, "second")
            expect([r1.seq, r2.seq]).toEqual([1, 2])
            expect([r1.id, r2.id]).toEqual([2, 4])
            // confirmed on the log entries themselves (via the spectator view)
            const msgs = room
                .eventsSince(0)
                .filter((e): e is Message => e.type === "message")
                .map((m) => [m.id, m.seq, m.message])
            expect(msgs).toEqual([
                [2, 1, "first"],
                [4, 2, "second"]
            ])
        })

        it("stamps sent_at as ISO-8601 UTC second-precision Z", async () => {
            const room = makeTestRoom()
            const [ta] = await room.jackin()
            await room.send(ta, "stamp me")
            const last = room.eventsSince(0).at(-1)
            expect(last?.sentAt).toMatch(ISO_UTC_Z_RE)
        })

        it("stamps the sender name on a delivered message", async () => {
            const room = makeTestRoom()
            const [ta] = await room.jackin()
            const [tb] = await room.jackin()
            const [tc] = await room.jackin()
            await room.send(ta, "from a")
            await room.send(tb, "from b")
            const out = await room.recv(tc, 0)
            // joins took id 1-3; the two messages are id 4 and 5
            expect(messageSenders(out.events)).toEqual([
                [4, "peer-1"],
                [5, "peer-2"]
            ])
        })
    })

    // -- per-token cursor --

    context("per-token cursor", () => {
        it("advances on delivery and heartbeats once drained", async () => {
            const room = makeTestRoom()
            const [ta] = await room.jackin()
            const [tb] = await room.jackin()
            await room.send(ta, "one")
            await room.send(ta, "two")
            const first = await room.recv(tb, 0)
            expect(messageSenders(first.events).map(([id]) => id)).toEqual([3, 4])
            await room.send(ta, "three")
            const second = await room.recv(tb, 0)
            expect(second.events.map((e) => e.id)).toEqual([5])
        })

        it("leaves the cursor untouched on a heartbeat", async () => {
            const room = makeTestRoom()
            const [ta] = await room.jackin()
            const [tb] = await room.jackin()
            await room.send(ta, "one")
            const first = await room.recv(tb, 0)
            expect(messageSenders(first.events).map(([id]) => id)).toEqual([3])
            const hb = await room.recv(tb, 0.05)
            expect(hb.events).toEqual([])
            await room.send(ta, "two")
            const third = await room.recv(tb, 0)
            expect(third.events.map((e) => e.id)).toEqual([4])
        })

        it("gives each token its own cursor", async () => {
            const room = makeTestRoom()
            const [ta] = await room.jackin()
            const [tb] = await room.jackin()
            const [tc] = await room.jackin()
            await room.send(ta, "shared")
            const outB = await room.recv(tb, 0)
            expect(messageSenders(outB.events).map(([id]) => id)).toEqual([4])
            const outC = await room.recv(tc, 0)
            expect(messageSenders(outC.events).map(([id]) => id)).toEqual([4])
            const againB = await room.recv(tb, 0.05)
            expect(againB.events).toEqual([])
        })
    })

    // -- a peer never sees events about itself (no echo) --

    context("don't-echo-self", () => {
        it("never echoes a peer its own message", async () => {
            const room = makeTestRoom()
            const [ta] = await room.jackin()
            await room.jackin()
            await room.send(ta, "mine")
            const out = await room.recv(ta, 0)
            expect(out.events.filter((e) => e.type === "message")).toEqual([])
        })

        it("does not skip others' messages interleaved above an own message", async () => {
            // joins id 1-3; peer-2 (id4), peer-1 own (id5), peer-3 (id6). peer-1 must
            // get [4,6] in order — id5 filtered, id6 NOT skipped.
            const room = makeTestRoom()
            const [t1] = await room.jackin()
            const [t2] = await room.jackin()
            const [t3] = await room.jackin()
            const id1 = (await room.send(t2, "from peer-2")).id
            const id2 = (await room.send(t1, "from peer-1")).id
            const id3 = (await room.send(t3, "from peer-3")).id
            expect([id1, id2, id3]).toEqual([4, 5, 6])
            const out = await room.recv(t1, 0)
            expect(messageSenders(out.events)).toEqual([
                [4, "peer-2"],
                [6, "peer-3"]
            ])
            // cursor advanced to 6 -> follow-up is a heartbeat (own id5 stays filtered)
            const follow = await room.recv(t1, 0.05)
            expect(follow.events).toEqual([])
        })

        it("still delivers an interleaved own message to OTHER peers", async () => {
            const room = makeTestRoom()
            const [t1] = await room.jackin()
            const [t2] = await room.jackin()
            const [t3] = await room.jackin()
            await room.send(t2, "from peer-2")
            await room.send(t1, "from peer-1")
            await room.send(t3, "from peer-3")
            const out = await room.recv(t2, 0)
            expect(messageSenders(out.events)).toEqual([
                [5, "peer-1"],
                [6, "peer-3"]
            ])
        })
    })

    // -- readYourLastMessage --

    context("readYourLastMessage", () => {
        it("is empty before the peer has sent anything", async () => {
            const room = makeTestRoom()
            const [ta] = await room.jackin()
            await room.jackin()
            const out = await room.recv(ta, 0.05)
            expect(out.readYourLastMessage).toEqual([])
        })

        it("reflects readers in join order", async () => {
            const room = makeTestRoom()
            const [ta] = await room.jackin()
            const [tb] = await room.jackin()
            const [tc] = await room.jackin()
            await room.send(ta, "anyone there?")
            expect((await room.recv(ta, 0.05)).readYourLastMessage).toEqual([])
            await room.recv(tb, 0)
            expect((await room.recv(ta, 0.05)).readYourLastMessage).toEqual(["peer-2"])
            await room.recv(tc, 0)
            expect((await room.recv(ta, 0.05)).readYourLastMessage).toEqual(["peer-2", "peer-3"])
        })

        it("excludes the sender itself", async () => {
            const room = makeTestRoom()
            const [ta] = await room.jackin()
            await room.send(ta, "talking to myself")
            const out = await room.recv(ta, 0.05)
            expect(out.readYourLastMessage).toEqual([])
        })

        it("tracks only the latest message", async () => {
            const room = makeTestRoom()
            const [ta] = await room.jackin()
            const [tb] = await room.jackin()
            await room.send(ta, "first")
            await room.recv(tb, 0)
            await room.send(ta, "second")
            expect((await room.recv(ta, 0.05)).readYourLastMessage).toEqual([])
            await room.recv(tb, 0)
            expect((await room.recv(ta, 0.05)).readYourLastMessage).toEqual(["peer-2"])
        })
    })

    // -- send's behindBy / presentPeers signal --

    context("send signal", () => {
        it("counts unseen OTHERS' messages in behindBy", async () => {
            const room = makeTestRoom()
            const [ta] = await room.jackin()
            const [tb] = await room.jackin()
            await room.send(tb, "from b one")
            await room.send(tb, "from b two")
            const out = await room.send(ta, "from a")
            expect(out.behindBy).toBe(2)
        })

        it("excludes a peer's own messages from behindBy", async () => {
            const room = makeTestRoom()
            const [ta] = await room.jackin()
            await room.jackin()
            expect((await room.send(ta, "mine one")).behindBy).toBe(0)
            expect((await room.send(ta, "mine two")).behindBy).toBe(0)
        })

        it("excludes presence from behindBy", async () => {
            const room = makeTestRoom()
            const [ta] = await room.jackin()
            const [tb] = await room.jackin()
            await room.jackout(tb)
            const out = await room.send(ta, "anyone?")
            expect(out.behindBy).toBe(0)
        })

        it("does NOT advance the cursor (send is not a consumer)", async () => {
            const room = makeTestRoom()
            const [ta] = await room.jackin()
            const [tb] = await room.jackin()
            await room.send(tb, "unread by a")
            const out = await room.send(ta, "from a")
            expect(out.behindBy).toBe(1)
            const after = await room.recv(ta, 0)
            expect(messageSenders(after.events)).toEqual([[3, "peer-2"]])
        })

        it("reports the live roster in presentPeers", async () => {
            const room = makeTestRoom()
            const [ta] = await room.jackin()
            const [tb] = await room.jackin()
            const out = await room.send(ta, "hello")
            expect(out.presentPeers).toEqual(["peer-1", "peer-2"])
            expect(out.presentPeers).toEqual(room.peers())
            await room.jackout(tb)
            const out2 = await room.send(ta, "just me now")
            expect(out2.presentPeers).toEqual(["peer-1"])
        })
    })

    // -- long-poll --

    context("long-poll", () => {
        it("returns immediately when unread exists", async () => {
            const room = makeTestRoom()
            const [ta] = await room.jackin()
            const [tb] = await room.jackin()
            await room.send(ta, "already here")
            const out = await room.recv(tb, 10)
            expect(messageSenders(out.events).map(([id]) => id)).toEqual([3])
        })

        it("wakes a parked recv on a send", async () => {
            const room = makeTestRoom()
            const [ta] = await room.jackin()
            const [tb] = await room.jackin()
            await room.recv(tb, 0) // drain tb's backlog so the next recv genuinely parks
            const recvPromise = room.recv(tb, 10)
            const sendPromise = (async () => {
                await new Promise((r) => setTimeout(r, 20))
                return room.send(ta, "wake up")
            })()
            const out = await recvPromise
            await sendPromise
            const msgs = out.events.filter((e): e is Message => e.type === "message")
            expect(msgs.map((e) => e.id)).toEqual([3])
            expect(msgs[0]?.message).toBe("wake up")
        })

        it("heartbeats after the wait with the live roster", async () => {
            const room = makeTestRoom()
            await room.jackin()
            const [tb] = await room.jackin()
            await room.recv(tb, 0)
            const out = await room.recv(tb, 0.05)
            expect(out.events).toEqual([])
            expect(out.presentPeers).toContain("peer-1")
            expect(out.presentPeers).toContain("peer-2")
        })

        it("clamps the wait to config.waitMax", async () => {
            const room = makeTestRoom()
            const [ta] = await room.jackin()
            // wait_max is 0.2; asking for 100 must still heartbeat quickly (a lone
            // peer's own join is filtered, so it parks).
            const out = await room.recv(ta, 100)
            expect(out.events).toEqual([])
        })
    })

    // -- quietFor --

    context("quietFor", () => {
        it("is null before any message (a join is not talk)", async () => {
            const room = makeTestRoom()
            const [ta] = await room.jackin()
            const out = await room.recv(ta, 0)
            expect(out.quietFor).toBeNull()
        })

        it("is zero right after a message", async () => {
            const { room } = idleRoom(10)
            const [ta] = await room.jackin()
            const [tb] = await room.jackin()
            await room.send(ta, "hi")
            const out = await room.recv(tb, 0)
            expect(out.quietFor).toBe(0)
        })

        it("grows as the clock advances", async () => {
            const { room, clock } = idleRoom(10)
            const [ta] = await room.jackin()
            const [tb] = await room.jackin()
            await room.send(ta, "hi")
            await room.recv(tb, 0)
            clock.now += 7
            const out = await room.recv(tb, 0.05)
            expect(out.events).toEqual([])
            expect(out.quietFor).toBe(7)
        })

        it("resets on a new message; presence in between does not count", async () => {
            const { room, clock } = idleRoom(10)
            const [ta] = await room.jackin()
            const [tb] = await room.jackin()
            await room.send(ta, "first")
            clock.now += 5
            await room.jackin() // a third peer joins — presence, not talk
            const out = await room.recv(tb, 0)
            expect(out.quietFor).toBe(5)
            await room.send(ta, "second")
            const out2 = await room.recv(tb, 0)
            expect(out2.quietFor).toBe(0)
        })
    })

    // -- presence events: join / leave on the stream --

    context("presence on the stream", () => {
        it("delivers a join to OTHER peers, well-formed", async () => {
            const room = makeTestRoom()
            const [ta] = await room.jackin("alice")
            await room.recv(ta, 0) // drain alice's own (filtered) join backlog
            const [, nb] = await room.jackin("bob")
            const out = await room.recv(ta, 0)
            const joins = out.events.filter((e): e is Presence => e.type === "action(join)")
            expect(joins.length).toBe(1)
            expect(joins[0]?.peer).toBe(nb)
            expect(joins[0]?.sentAt).toMatch(ISO_UTC_Z_RE)
        })

        it("delivers a leave to OTHER peers, well-formed", async () => {
            const room = makeTestRoom()
            const [ta] = await room.jackin("alice")
            const [tb, nb] = await room.jackin("bob")
            await room.recv(ta, 0) // drain bob's join
            await room.jackout(tb)
            const out = await room.recv(ta, 0)
            const leaves = out.events.filter((e): e is Presence => e.type === "action(leave)")
            expect(leaves.length).toBe(1)
            expect(leaves[0]?.peer).toBe(nb)
            expect(leaves[0]?.sentAt).toMatch(ISO_UTC_Z_RE)
        })

        it("filters a peer's own join and leave from its own stream", async () => {
            const room = makeTestRoom()
            const [ta] = await room.jackin("alice")
            expect((await room.recv(ta, 0)).events).toEqual([])
            const [tb, nb] = await room.jackin("bob")
            await room.jackout(tb)
            const outB = await room.recv(tb, 0)
            const aboutBob = outB.events.filter((e) => e.type !== "message" && (e as Presence).peer === nb)
            expect(aboutBob).toEqual([])
            // what bob DOES see is alice's join (presence about alice)
            expect(outB.events.map((e) => [e.type, (e as Presence).peer])).toEqual([["action(join)", "alice-1"]])
        })

        it("backfills prior events (joins + messages) for a late joiner", async () => {
            const room = makeTestRoom()
            const [ta, na] = await room.jackin("alice")
            await room.send(ta, "early bird")
            const [tb] = await room.jackin("bob")
            const out = await room.recv(tb, 0)
            const shape = out.events.map((e) => [e.id, e.type, e.type === "message" ? e.sender : e.peer])
            expect(shape).toEqual([
                [1, "action(join)", na],
                [2, "message", na]
            ])
        })

        it("rides presence and messages on one climbing event-id counter", async () => {
            const room = makeTestRoom()
            const [ta] = await room.jackin("alice")
            await room.jackin("bob")
            const msgId = (await room.send(ta, "hi")).id
            const [tc] = await room.jackin("carol")
            expect(msgId).toBe(3)
            const out = await room.recv(tc, 0)
            expect(out.events.map((e) => e.id)).toEqual([1, 2, 3])
        })
    })

    // -- idle peer drop: reapIdle on the injected clock --

    context("idle reap", () => {
        it("drops a peer past the timeout with exactly one leave", async () => {
            const { room, clock } = idleRoom(10)
            const [, n1] = await room.jackin()
            await room.jackin()
            clock.now += 11
            await room.reapIdle()
            expect(room.peers()).not.toContain(n1)
            expect(presenceAbout(room, "action(leave)", n1).length).toBe(1)
        })

        it("keeps a peer under the timeout (strict > boundary)", async () => {
            const { room, clock } = idleRoom(10)
            const [, n1] = await room.jackin()
            clock.now += 9
            await room.reapIdle()
            expect(room.peers()).toContain(n1)
            expect(presenceAbout(room, "action(leave)", n1)).toEqual([])
        })

        it("survives at EXACTLY the timeout, drops one tick past", async () => {
            const { room, clock } = idleRoom(10)
            const [, n1] = await room.jackin()
            await room.jackin()
            clock.now = 1010 // 1010 - 1000 == 10, NOT > 10
            await room.reapIdle()
            expect(room.peers()).toContain(n1)
            expect(presenceAbout(room, "action(leave)", n1)).toEqual([])
            clock.now = 1010.001
            await room.reapIdle()
            expect(room.peers()).not.toContain(n1)
            expect(presenceAbout(room, "action(leave)", n1).length).toBe(1)
        })

        it("re-adds a peer on activity after a drop, one new join", async () => {
            const { room, clock } = idleRoom(10)
            const [t1, n1] = await room.jackin()
            await room.jackin()
            expect(presenceAbout(room, "action(join)", n1).length).toBe(1)
            clock.now += 11
            await room.reapIdle()
            expect(room.peers()).not.toContain(n1)
            await room.recv(t1, 0)
            expect(room.peers()).toContain(n1)
            expect(presenceAbout(room, "action(join)", n1).length).toBe(2)
        })

        it("is idempotent — a second sweep emits no second leave", async () => {
            const { room, clock } = idleRoom(10)
            const [, n1] = await room.jackin()
            await room.jackin()
            clock.now += 11
            await room.reapIdle()
            expect(presenceAbout(room, "action(leave)", n1).length).toBe(1)
            clock.now += 100
            await room.reapIdle()
            expect(presenceAbout(room, "action(leave)", n1).length).toBe(1)
        })

        it("rejoins the SAME token after jackout on its next call", async () => {
            const { room } = idleRoom(10)
            const [t1, n1] = await room.jackin()
            await room.jackin()
            await room.jackout(t1)
            expect(room.peers()).not.toContain(n1)
            expect(room.status(t1)).toBe("valid")
            await room.recv(t1, 0)
            expect(room.peers()).toContain(n1)
            expect(presenceAbout(room, "action(join)", n1).length).toBe(2)
        })

        it("never reaps when idle_timeout is 0", async () => {
            const { room, clock } = idleRoom(0)
            const [, n1] = await room.jackin()
            clock.now += 100_000
            await room.reapIdle()
            expect(room.peers()).toContain(n1)
            expect(presenceAbout(room, "action(leave)", n1)).toEqual([])
        })

        it("rejects a config whose idle_timeout <= wait_max", () => {
            expect(() =>
                makeConfig({
                    host: "127.0.0.1",
                    port: 0,
                    secret: "s3cr3t",
                    topic: "testing the wire",
                    waitMax: 60,
                    idleTimeout: 30
                })
            ).toThrow()
        })
    })

    // -- idle reap: parked-poller survives (the marquee invariant) --

    context("parked poller survival", () => {
        it("is NOT reaped when a sweep runs mid-park (entry stamp protects it)", async () => {
            const { room, clock } = idleRoom(10)
            const [t1, n1] = await room.jackin() // lastActive = 1000
            const [t2] = await room.jackin()
            await room.recv(t1, 0) // drain peer-1's backlog
            clock.now = 1011 // jackin stamps (1000) now stale
            await room.recv(t2, 0) // keep the anchor fresh at 1011
            const recvPromise = room.recv(t1, 0.2) // ENTRY stamp fires at 1011
            await new Promise((r) => setTimeout(r, 20)) // let it reach the park
            await room.reapIdle() // 1011 - 1011 = 0, not > 10 -> survives
            expect(room.peers()).toContain(n1)
            expect(presenceAbout(room, "action(leave)", n1)).toEqual([])
            const out = await recvPromise
            expect(out.events).toEqual([])
            expect(room.peers()).toContain(n1)
        })

        it("counterfactual: the recv-entry stamp is what keeps it alive", async () => {
            const { room, clock } = idleRoom(10)
            const [t1, n1] = await room.jackin()
            await room.jackin()
            clock.now = 1011
            await room.reapIdle()
            expect(room.peers()).not.toContain(n1) // staleness drops it
            await room.recv(t1, 0) // stamps at 1011, rejoins
            expect(room.peers()).toContain(n1)
            await room.reapIdle() // 1011 - 1011 = 0
            expect(room.peers()).toContain(n1)
            expect(presenceAbout(room, "action(join)", n1).length).toBe(2)
        })
    })

    // -- reaper-vs-rejoin transition ordering (no double-announce) --

    context("transition ordering", () => {
        it("reap -> rejoin -> reap-while-fresh is a no-op", async () => {
            const { room, clock } = idleRoom(10)
            const [t1, n1] = await room.jackin()
            await room.jackin()
            clock.now = 1011
            await room.reapIdle() // leave #1
            expect(presenceAbout(room, "action(leave)", n1).length).toBe(1)
            expect(room.peers()).not.toContain(n1)
            await room.recv(t1, 0) // rejoin (join #2)
            expect(presenceAbout(room, "action(join)", n1).length).toBe(2)
            expect(room.peers()).toContain(n1)
            await room.reapIdle() // fresh -> no-op
            expect(presenceAbout(room, "action(leave)", n1).length).toBe(1)
            expect(room.peers()).toContain(n1)
        })

        it("reap-while-already-absent emits no leave", async () => {
            const { room, clock } = idleRoom(10)
            const [t1, n1] = await room.jackin()
            await room.jackin()
            await room.jackout(t1) // leave #1
            expect(presenceAbout(room, "action(leave)", n1).length).toBe(1)
            clock.now = 5000
            await room.reapIdle()
            expect(presenceAbout(room, "action(leave)", n1).length).toBe(1)
            expect(room.peers()).not.toContain(n1)
        })

        it("a full leave/join/leave cycle is balanced (2 joins, 2 leaves)", async () => {
            const { room, clock } = idleRoom(10)
            const [t1, n1] = await room.jackin() // join #1
            await room.jackin()
            clock.now = 1011
            await room.reapIdle() // leave #1
            await room.recv(t1, 0) // join #2
            clock.now = 1011 + 11
            await room.reapIdle() // leave #2
            expect(presenceAbout(room, "action(join)", n1).length).toBe(2)
            expect(presenceAbout(room, "action(leave)", n1).length).toBe(2)
            expect(room.peers()).not.toContain(n1)
        })
    })

    // -- multi-peer reap: only idle drops; name stability on rejoin --

    context("multi-peer reap", () => {
        it("drops only idle peers; active ones survive in join order", async () => {
            const { room, clock } = idleRoom(10)
            const [, n1] = await room.jackin()
            const [t2, n2] = await room.jackin()
            const [t3, n3] = await room.jackin()
            clock.now = 1008
            await room.recv(t2, 0)
            await room.recv(t3, 0)
            clock.now = 1011
            await room.reapIdle()
            expect(room.peers()).toEqual([n2, n3])
            expect(presenceAbout(room, "action(leave)", n1).length).toBe(1)
            expect(presenceAbout(room, "action(leave)", n2)).toEqual([])
            expect(presenceAbout(room, "action(leave)", n3)).toEqual([])
        })

        it("rejoins a reaped peer with its ORIGINAL name (no inflation)", async () => {
            const { room, clock } = idleRoom(10)
            const [t1, n1] = await room.jackin("alice")
            await room.jackin()
            expect(n1).toBe("alice-1")
            clock.now = 1011
            await room.reapIdle()
            expect(room.peers()).not.toContain(n1)
            await room.recv(t1, 0)
            expect(room.peerNameFor(t1)).toBe("alice-1")
            expect(room.peers()).toContain("alice-1")
            expect(room.peers()).not.toContain("alice-2")
        })

        it("drops all idle peers in one sweep, emptying the roster", async () => {
            const { room, clock } = idleRoom(10)
            const [, n1] = await room.jackin()
            const [, n2] = await room.jackin()
            const [, n3] = await room.jackin()
            clock.now = 1011
            await room.reapIdle()
            expect(room.peers()).toEqual([])
            expect(presenceAbout(room, "action(leave)", n1).length).toBe(1)
            expect(presenceAbout(room, "action(leave)", n2).length).toBe(1)
            expect(presenceAbout(room, "action(leave)", n3).length).toBe(1)
        })
    })

    // -- leave/join visibility + subject filter --

    context("reap visibility", () => {
        it("makes a reaped leave visible to others, filtered from self", async () => {
            const { room, clock } = idleRoom(10)
            const [t1, n1] = await room.jackin()
            const [t2] = await room.jackin()
            await room.recv(t2, 0) // drain peer-1's join
            clock.now = 1011
            await room.reapIdle()
            const outObs = await room.recv(t2, 0)
            const leaves = outObs.events.filter((e): e is Presence => e.type === "action(leave)")
            expect(leaves.length).toBe(1)
            expect(leaves[0]?.peer).toBe(n1)
            expect(leaves[0]?.sentAt).toMatch(ISO_UTC_Z_RE)
            // the reaped peer rejoins on its next call; its OWN leave is never echoed
            const outSelf = await room.recv(t1, 0)
            expect(outSelf.events.filter((e) => e.type !== "message" && (e as Presence).peer === n1)).toEqual([])
        })

        it("makes a rejoin's join visible to others, filtered from self", async () => {
            const { room, clock } = idleRoom(10)
            const [t1, n1] = await room.jackin()
            const [t2] = await room.jackin()
            clock.now = 1011
            await room.reapIdle()
            await room.recv(t1, 0) // peer-1 rejoins -> join #2
            const outObs = await room.recv(t2, 0)
            const joinsP1 = outObs.events.filter((e): e is Presence => e.type === "action(join)" && e.peer === n1)
            expect(joinsP1.length).toBe(2)
            const outSelf = await room.recv(t1, 0)
            expect(outSelf.events.filter((e) => e.type === "action(join)" && (e as Presence).peer === n1)).toEqual([])
        })
    })

    // -- empty-room self-close: shouldSelfClose on the injected clock --

    context("empty-room self-close", () => {
        it("fires after grace once empty", async () => {
            const { room, clock } = graceRoom(100)
            const [t1] = await room.jackin()
            expect(await room.shouldSelfClose()).toBe(false)
            await room.jackout(t1)
            clock.now += 101
            expect(await room.shouldSelfClose()).toBe(true)
        })

        it("does not fire before grace (strict > boundary)", async () => {
            const { room, clock } = graceRoom(100)
            const [t1] = await room.jackin()
            await room.jackout(t1) // emptySince = 1000
            clock.now = 1050
            expect(await room.shouldSelfClose()).toBe(false)
            clock.now = 1100 // exactly at grace -> survives
            expect(await room.shouldSelfClose()).toBe(false)
            clock.now = 1100.001 // one tick past -> fires
            expect(await room.shouldSelfClose()).toBe(true)
        })

        it("is rescued by a fresh jackin", async () => {
            const { room, clock } = graceRoom(100)
            const [t1] = await room.jackin()
            await room.jackout(t1)
            clock.now += 200
            expect(await room.shouldSelfClose()).toBe(true)
            await room.jackin()
            expect(await room.shouldSelfClose()).toBe(false)
        })

        it("is rescued by a rejoin via the immortal token (recv)", async () => {
            const { room, clock } = graceRoom(100)
            const [tok] = await room.jackin()
            await room.jackout(tok)
            clock.now += 200
            expect(await room.shouldSelfClose()).toBe(true)
            await room.recv(tok, 0)
            expect(await room.shouldSelfClose()).toBe(false)
        })

        it("is rescued by a rejoin via send", async () => {
            const { room, clock } = graceRoom(100)
            const [tok] = await room.jackin()
            await room.jackout(tok)
            clock.now += 200
            expect(await room.shouldSelfClose()).toBe(true)
            await room.send(tok, "back")
            expect(await room.shouldSelfClose()).toBe(false)
        })

        it("is BOOT-ARMED: a never-joined room still dies", async () => {
            const { room, clock } = graceRoom(100)
            expect(room.peers()).toEqual([])
            expect(await room.shouldSelfClose()).toBe(false)
            clock.now += 101
            expect(await room.shouldSelfClose()).toBe(true)
        })

        it("never fires when empty_grace is 0", async () => {
            const { room, clock } = graceRoom(0)
            expect(await room.shouldSelfClose()).toBe(false)
            clock.now += 10_000_000
            expect(await room.shouldSelfClose()).toBe(false)
            const [t1] = await room.jackin()
            await room.jackout(t1)
            clock.now += 10_000_000
            expect(await room.shouldSelfClose()).toBe(false)
        })

        it("is cancelled by a last-instant join", async () => {
            const { room, clock } = graceRoom(100)
            const [t1] = await room.jackin()
            await room.jackout(t1)
            clock.now += 200 // a poll right now would self-close
            await room.jackin() // but a join lands first
            expect(await room.shouldSelfClose()).toBe(false)
        })

        it("cascades additively after an idle drop (not overlapping)", async () => {
            const { room, clock } = graceRoom(100, 10)
            const [, n1] = await room.jackin()
            expect(await room.shouldSelfClose()).toBe(false)
            clock.now += 11 // lone peer now idle
            await room.reapIdle() // empty -> emptySince stamped HERE
            expect(room.peers()).not.toContain(n1)
            expect(await room.shouldSelfClose()).toBe(false) // ~0 elapsed since the reap
            clock.now += 101
            expect(await room.shouldSelfClose()).toBe(true)
        })
    })
})
