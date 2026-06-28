/**
 * room.ts — the framework-free core of a wire room.
 *
 * Holds all room state — token->peer binding, the message log, the room-global
 * event-`id` counter (stream position / read-cursor key) plus a separate
 * message-only `seq` counter, per-token read cursors, and the long-poll wake.
 * Imports neither an HTTP framework nor a schema lib; depends only on the
 * primitives: {@link Config}, {@link Clock}, and {@link Condition}.
 *
 * Single-threaded Bun, no locks: mutations are serialized against the long-poll
 * for free — nothing preempts between two synchronous statements, so each
 * mutation runs to completion before any parked `recv` re-tests. The one
 * `Condition` is just the wake: `notifyAll()` on every write (message OR
 * presence), and `recv` parks via `waitFor(predicate, timeoutMs)`.
 */

import * as crypto from "node:crypto"
import type { Clock } from "./clock"
import { monotonic } from "./clock"
import type { Condition } from "./condition"
import { makeCondition } from "./condition"
import type { Config } from "./config"

// Internal whitespace runs and underscores fold to a single `-` (full kebab: so
// "my agent" and "my_agent" both -> "my-agent", not deleted) — `-` is the only
// separator, doubling as the `-<n>` suffix delimiter.
const WS_RE = /[\s_]+/g
// After lowercasing + folding to `-`, anything outside this set is stripped (no
// underscore in the output set — true kebab).
const NAME_CHARS_RE = /[^a-z0-9-]/g
// Slug-clean: collapse consecutive `-` runs to one (e.g. "a--b" -> "a-b").
const SEP_RUN_RE = /-{2,}/g
// Strip leading/trailing `-` after slug-cleaning.
const EDGE_SEP_RE = /^-+|-+$/g
// Cap on a name base after normalizing (the `<n>` suffix is appended on top).
const BASE_MAX = 32
// Base used when no usable name was requested.
const DEFAULT_BASE = "peer"
// Token entropy in bytes; base64url-encoded.
const TOKEN_BYTES = 32

/**
 * Outcome of validating a token, for the auth layer to map to a 401 body.
 *
 * Tokens are IMMORTAL: once jackin mints one it is VALID for the room's life;
 * nothing — neither jackout nor an idle drop — invalidates it. Roster presence
 * is separate state (see `Peer.inRoster`), so this is just a two-way
 * "minted here or not" verdict.
 *
 *   UNKNOWN — never minted (or malformed) -> "invalid token"
 *   VALID   — minted by this room         -> proceed
 */
export type TokenStatus = "unknown" | "valid"

/**
 * One room message. The HTTP layer renames `sender` to `from` in JSON.
 *
 * A log entry of `type === "message"` — its *subject* (the peer it's about, for
 * the don't-echo-me filter) is its `sender`. Carries TWO counters: `id` is the
 * room-global event id (its stream position / read-cursor key, shared with
 * presence events), while `seq` is the message-only counter that climbs 1, 2,
 * 3… with no gaps — presence events never burn a `seq`.
 */
export type Message = {
    readonly type: "message"
    readonly id: number
    readonly seq: number
    readonly sender: string
    readonly message: string
    // Authoritative send time, stamped in send(): ISO-8601 UTC, second
    // precision, Z-suffixed (e.g. "2026-06-18T13:57:02Z"). id still defines
    // stream order; this is the wall-clock instant the message was created.
    readonly sentAt: string
}

/** A join/leave presence event's wire type — the parens are part of the string. */
export type PresenceType = "action(join)" | "action(leave)"

/**
 * A join/leave event. A log entry that rides the same event-`id`-ordered stream
 * as messages; its `type` is literally `"action(join)"` or `"action(leave)"`.
 * Its *subject* (the peer it's about, for the don't-echo-me filter) is its
 * `peer`. Unlike a message it carries only `id` (the room-global event id) —
 * there is no message-only `seq` on presence.
 */
export type Presence = {
    readonly type: PresenceType
    readonly id: number
    readonly peer: string
    // Same stamp contract as Message.sentAt: ISO-8601 UTC, second precision, Z.
    readonly sentAt: string
}

/**
 * A log entry is either a message or a presence event; both carry id/type/
 * sentAt, and both have a *subject* — the peer the entry is about, used to skip
 * entries about the caller in recv().
 */
export type LogEntry = Message | Presence

/** The result of {@link Room.send}: the just-sent ids plus a free unread signal. */
export type SendResult = {
    readonly id: number
    readonly seq: number
    readonly behindBy: number
    readonly presentPeers: string[]
}

/** The result of {@link Room.recv}: drained events plus the roster/silence signal. */
export type RecvResult = {
    readonly events: LogEntry[]
    readonly presentPeers: string[]
    readonly readYourLastMessage: string[]
    readonly quietFor: number | null
}

/** The {@link Room.spectateRoster} snapshot: the live roster + silence, no backlog. */
export type SpectateRoster = {
    readonly presentPeers: string[]
    readonly quietFor: number | null
}

/**
 * The peer a log entry is *about*: the sender of a message, or the peer of a
 * presence event. recv() never delivers an entry whose subject is the caller
 * (generalizes don't-echo-my-own-message to skip-events-about-me).
 */
const subjectOf = (entry: LogEntry): string => (entry.type === "message" ? entry.sender : entry.peer)

/** Authoritative wall-clock stamp: ISO-8601 UTC, second precision, Z-form. */
const nowIso = (): string => `${new Date().toISOString().slice(0, 19)}Z`

/** Internal per-token state. */
type Peer = {
    readonly name: string
    // Whether this peer is currently SHOWN in the roster — "recently active",
    // NOT token liveness (the token is immortal). Flipped only by setPresent:
    // true on join (jackin / activity after a drop), false on leave (jackout /
    // idle reap). peers() lists exactly the inRoster peers.
    inRoster: boolean
    // Monotonic seconds (via the room clock) of this peer's last token-bearing
    // call — stamped on jackin and at recv ENTRY, send, jackout. The idle reaper
    // drops a peer once now - lastActive exceeds the idle timeout. 0 until first set.
    lastActive: number
    // Highest event id this token has been delivered (its read cursor). 0 = nothing read.
    cursor: number
    // Highest event id this token has itself sent (0 = has never sent).
    lastSent: number
}

/**
 * The pure async core. Build via {@link makeRoom}.
 *
 * The methods group into: the membership surface
 * (jackin/jackout/touch/reapIdle), the token-validation surface
 * (status/isKnown/peerNameFor), messaging (send/recv), the empty-room decision
 * (shouldSelfClose), and the tokenless spectator surface (cond/eventId/
 * eventsSince/spectateRoster/peers).
 */
export type Room = {
    // -- token validation surface (for the auth layer) --
    status: (token: string) => TokenStatus
    isKnown: (token: string) => boolean
    peerNameFor: (token: string) => string | null
    // -- membership --
    jackin: (requested?: string | null) => Promise<[token: string, name: string]>
    touch: (token: string) => Promise<void>
    jackout: (token: string) => Promise<string>
    reapIdle: () => Promise<void>
    peers: () => string[]
    shouldSelfClose: () => Promise<boolean>
    // -- messaging --
    send: (token: string, text: string) => Promise<SendResult>
    recv: (token: string, wait?: number | null) => Promise<RecvResult>
    // -- spectator surface (read-only; no token, no roster presence) --
    readonly cond: Condition
    readonly eventId: number
    eventsSince: (eventId: number) => LogEntry[]
    spectateRoster: () => SpectateRoster
}

/**
 * Build room state from `config` and install the monotonic-clock seam.
 *
 * `now` is the injectable monotonic clock (float SECONDS) — every elapsed-time
 * read goes through it; tests pass a `fakeClock` to drive reapIdle/shouldSelfClose
 * without real sleeps.
 *
 * The load-bearing `idleTimeout > waitMax` invariant is enforced in
 * {@link makeConfig}, so a `Config` that reaches here already satisfies it — a
 * parked recv holds a peer silent up to waitMax and would otherwise be reaped.
 */
export const makeRoom = (config: Config, now: Clock = monotonic): Room => {
    // The room's idle threshold (seconds); 0 disables idle drop entirely.
    const idleTimeout = config.idleTimeout
    // The empty-room grace (seconds); 0 disables empty-room self-close.
    const emptyGrace = config.emptyGrace
    // Heterogeneous, event-id-ordered: messages and presence events interleave.
    const messages: LogEntry[] = []
    // token -> Peer
    const peersByToken = new Map<string, Peer>()
    // names in join order (never shrinks; a name is bound for the room's life)
    const joinOrder: string[] = []
    // The single long-poll wake — notifyAll() on every write, recv parks on it.
    const cond = makeCondition()

    // Room-global event id: the stream position / read-cursor key, bumped for
    // EVERY log entry (message or presence).
    let eventId = 0
    // Message-only counter: climbs 1, 2, 3… with no gaps, untouched by presence
    // events. Stamped onto Message.seq; first message -> seq 1.
    let msgSeq = 0
    // Monotonic instant (via now) of the most recent CHAT message — what drives
    // recv's `quietFor`. Stamped in send() only; presence join/leave is not talk
    // and never touches it. null until the first message, so `quietFor` reads
    // null on a room where no one has spoken. Monotonic (not the wall-clock
    // Message.sentAt) so it rides the same clock seam as the idle reaper.
    let lastMsgAt: number | null = null
    // Monotonic instant the roster last became empty, or null while occupied.
    // BOOT-ARMED: stamped to "now" at construction so a never-joined room has a
    // live countdown from boot (the first jackin clears it to null). Maintained
    // in exactly one place — the setPresent choke point — so every roster flip
    // keeps it honest.
    let emptySince: number | null = now()

    /**
     * Resolve `requested` to a `<base>-<n>` name unique in this room.
     *
     * `base` is normalized from the request, in order: trim surrounding
     * whitespace; lowercase; fold internal whitespace runs *and* underscores to
     * a single `-` (full kebab); strip any char outside `[a-z0-9-]`; slug-clean
     * (collapse `-` runs to one and strip leading/trailing `-`); cap at 32 chars;
     * empty after all that -> `peer`. `n` = the lowest positive integer for which
     * `<base>-<n>` is not yet taken (case-insensitive against every name ever
     * assigned, alive or dead).
     */
    const assignName = (requested: string | null | undefined): string => {
        let base = DEFAULT_BASE
        if (requested !== null && requested !== undefined) {
            const slug = requested
                .trim()
                .toLowerCase()
                .replace(WS_RE, "-")
                .replace(NAME_CHARS_RE, "")
                .replace(SEP_RUN_RE, "-")
                .replace(EDGE_SEP_RE, "")
                .slice(0, BASE_MAX)
            if (slug) {
                base = slug
            }
        }
        const taken = new Set(joinOrder.map((name) => name.toLowerCase()))
        let n = 1
        while (taken.has(`${base}-${n}`.toLowerCase())) {
            n += 1
        }
        return `${base}-${n}`
    }

    /** Currently in-roster peer names, in join order. */
    const peers = (): string[] => {
        const inRoster = new Set<string>()
        for (const peer of peersByToken.values()) {
            if (peer.inRoster) {
                inRoster.add(peer.name)
            }
        }
        return joinOrder.filter((name) => inRoster.has(name))
    }

    /**
     * The ONE place roster membership flips. Idempotent.
     *
     * On a real transition it appends the matching presence entry (`eventType` is
     * `action(join)` or `action(leave)`) on the next event id and wakes parked
     * recvs. Maintains the empty-room stamp from the POST-flip roster — re-arms
     * `emptySince` on the flip that empties the roster, clears it to null whenever
     * anyone is present. Single-threaded: no lock needed; callers run this between
     * `await` points so no parked recv re-tests mid-flip.
     */
    const setPresent = (peer: Peer, present: boolean, eventType: PresenceType): void => {
        if (peer.inRoster === present) {
            return
        }
        peer.inRoster = present
        eventId += 1
        messages.push({ type: eventType, id: eventId, peer: peer.name, sentAt: nowIso() })
        cond.notifyAll()
        let rosterEmpty = true
        for (const p of peersByToken.values()) {
            if (p.inRoster) {
                rosterEmpty = false
                break
            }
        }
        if (rosterEmpty) {
            if (emptySince === null) {
                emptySince = now()
            }
        } else {
            emptySince = null
        }
    }

    /**
     * Stamp `peer` active now and rejoin it if it had dropped. Shared body behind
     * {@link touch} and the entry-stamp in send/recv, so activity is recorded
     * through one path no matter which call carried the token.
     */
    const markActive = (peer: Peer): void => {
        peer.lastActive = now()
        setPresent(peer, true, "action(join)")
    }

    /** How many unread CHAT messages from OTHERS sit past `peer`'s cursor. */
    const behindBy = (peer: Peer): number => {
        let count = 0
        for (const entry of messages) {
            if (entry.type === "message" && entry.id > peer.cursor && entry.sender !== peer.name) {
                count += 1
            }
        }
        return count
    }

    /**
     * In-roster peers (excluding self) whose cursor has reached `peer`'s most
     * recent sent message. Empty if this peer hasn't sent anything.
     */
    const readYourLastMessage = (peer: Peer): string[] => {
        if (peer.lastSent === 0) {
            return []
        }
        const readers = new Set<string>()
        for (const p of peersByToken.values()) {
            if (p.inRoster && p.name !== peer.name && p.cursor >= peer.lastSent) {
                readers.add(p.name)
            }
        }
        return joinOrder.filter((name) => readers.has(name))
    }

    /**
     * Whole seconds since the most recent CHAT message, or `null` if no message
     * has been sent yet. Measured on the monotonic seam against the last-talk
     * stamp set in send(); presence join/leave never bumps it. Floored to whole
     * seconds and clamped at 0 (never negative).
     */
    const quietFor = (): number | null => {
        if (lastMsgAt === null) {
            return null
        }
        return Math.max(0, Math.floor(now() - lastMsgAt))
    }

    /**
     * True iff some log entry past `peer`'s cursor is about *someone else*. A
     * peer's own entries (its messages, its own join/leave) never count, so if
     * only its own sit past the cursor, recv parks and heartbeats.
     */
    const hasUnread = (peer: Peer): boolean => {
        for (const entry of messages) {
            if (entry.id > peer.cursor && subjectOf(entry) !== peer.name) {
                return true
            }
        }
        return false
    }

    const status = (token: string): TokenStatus => (peersByToken.has(token) ? "valid" : "unknown")

    const isKnown = (token: string): boolean => peersByToken.has(token)

    const peerNameFor = (token: string): string | null => peersByToken.get(token)?.name ?? null

    const requirePeer = (token: string): Peer => {
        const peer = peersByToken.get(token)
        if (peer === undefined) {
            throw new Error(`unknown token: ${token}`)
        }
        return peer
    }

    const jackin = async (requested: string | null = null): Promise<[token: string, name: string]> => {
        const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url")
        const name = assignName(requested)
        // Created OUT of the roster, then flipped in via the single setPresent
        // choke point so the join announce shares that one code path; activity is
        // stamped first so the fresh peer starts its idle clock now.
        const peer: Peer = { name, inRoster: false, lastActive: now(), cursor: 0, lastSent: 0 }
        peersByToken.set(token, peer)
        joinOrder.push(name)
        setPresent(peer, true, "action(join)")
        return [token, name]
    }

    const touch = async (token: string): Promise<void> => {
        markActive(requirePeer(token))
    }

    const jackout = async (token: string): Promise<string> => {
        const peer = requirePeer(token)
        // Stamp the activity directly (NOT via markActive, which would rejoin) so
        // jackout's net roster effect is purely the leave — a peer that had
        // already dropped doesn't churn an extra join here.
        peer.lastActive = now()
        setPresent(peer, false, "action(leave)")
        return peer.name
    }

    const reapIdle = async (): Promise<void> => {
        if (idleTimeout === 0) {
            return
        }
        const at = now()
        for (const peer of [...peersByToken.values()]) {
            if (peer.inRoster && at - peer.lastActive > idleTimeout) {
                setPresent(peer, false, "action(leave)")
            }
        }
    }

    const shouldSelfClose = async (): Promise<boolean> => {
        if (emptyGrace === 0) {
            return false
        }
        return emptySince !== null && now() - emptySince > emptyGrace
    }

    const eventsSince = (since: number): LogEntry[] => messages.filter((entry) => entry.id > since)

    const spectateRoster = (): SpectateRoster => ({ presentPeers: peers(), quietFor: quietFor() })

    const send = async (token: string, text: string): Promise<SendResult> => {
        const peer = requirePeer(token)
        // Activity choke point: stamp + rejoin if dropped, BEFORE the message is
        // logged. A rejoin's join entry takes the earlier id, the message the
        // next — both wake the same parked recvs.
        markActive(peer)
        eventId += 1
        msgSeq += 1
        const id = eventId
        const seq = msgSeq
        messages.push({ type: "message", id, seq, sender: peer.name, message: text, sentAt: nowIso() })
        // Mark the room's last-talk instant on the monotonic seam (same clock the
        // idle reaper reads) so recv's `quietFor` measures the lull from here.
        // Only chat moves it — presence is not talk.
        lastMsgAt = now()
        // lastSent is the event id (stream position), NOT msgSeq — read-receipts
        // compare against other peers' id-based cursors.
        peer.lastSent = id
        cond.notifyAll()
        // Snapshot the unread signal after the append for a consistent view.
        // behindBy is a pure count off the current cursor (the just-sent message
        // is excluded by the sender filter), NOT a peek or advance.
        return { id, seq, behindBy: behindBy(peer), presentPeers: peers() }
    }

    const recv = async (token: string, wait: number | null = null): Promise<RecvResult> => {
        const waitSeconds = Math.min(wait ?? config.waitDefault, config.waitMax)
        const peer = requirePeer(token)
        // Activity choke point — stamp at recv ENTRY, before parking, so a peer
        // that re-polls within idleTimeout stays alive even though a long park
        // then holds it silent up to waitMax (< idleTimeout). If it had dropped,
        // this rejoins it (one join entry) before we read. NEVER stamp on event
        // return: a present-but-quiet long-poller would then look idle and get reaped.
        markActive(peer)
        if (!hasUnread(peer)) {
            // waitFor resolves true on unread or false on timeout. waitSeconds is
            // a float count of SECONDS (the clock contract); the condition timer
            // is in milliseconds.
            const woke = await cond.waitFor(() => hasUnread(peer), waitSeconds * 1000)
            if (!woke) {
                // Heartbeat: nothing new, cursor untouched. Still reports the
                // roster and the lull so an empty heartbeat reads as alive.
                return {
                    events: [],
                    presentPeers: peers(),
                    readYourLastMessage: readYourLastMessage(peer),
                    quietFor: quietFor()
                }
            }
        }
        // A peer never sees events about itself. id is global, so others' entries
        // may interleave below our own; filtering by subject here (not by jumping
        // the cursor) keeps theirs from being skipped.
        const events = messages.filter((entry) => entry.id > peer.cursor && subjectOf(entry) !== peer.name)
        const last = events[events.length - 1]
        if (last !== undefined) {
            // Advance only to the max id actually delivered (non-own). An own
            // entry sitting above this max stays filtered on later recvs.
            peer.cursor = last.id
        }
        return {
            events,
            presentPeers: peers(),
            readYourLastMessage: readYourLastMessage(peer),
            quietFor: quietFor()
        }
    }

    return {
        status,
        isKnown,
        peerNameFor,
        jackin,
        touch,
        jackout,
        reapIdle,
        peers,
        shouldSelfClose,
        send,
        recv,
        get cond(): Condition {
            return cond
        },
        get eventId(): number {
            return eventId
        },
        eventsSince,
        spectateRoster
    }
}
