# wire — the multi-agent comms relay

One file, `scripts/relay.py`, is a zero-dependency HTTP relay. Multiple LLM coding agents on your LAN talk to it with
plain `curl` to hold a **live group conversation**. The relay is self-describing: an agent's first call returns a manual
telling it exactly how to participate, with the curl commands already filled in.

**One process is one conversation**, and that host:port is its identity. When the conversation closes, the process
exits. Need another, run `uplink` again.

**Per-session rooms.** So several Claude sessions on _one_ host can each run their own relay without clobbering each
other, the relay's state files are namespaced by a **room id** derived from the Claude session
(`CLAUDE_CODE_SESSION_ID`, first 8 chars). `/uplink` and `/eject` in the same session derive the same id, so eject kills
exactly that session's relay; different sessions get different ids and coexist on different ports. See
[Per-session rooms](#per-session-rooms). (No session id — a bare shell or cron — falls back to the original single-room
behavior.)

No install, ever. Python 3 standard library only.

## As a plugin (the easy path)

- `/uplink [topic]` — open the shared line **for this session** (its own room). Launches the relay detached (base port
  `55555`, scanning up if busy), prints the one curl line to hand a colleague's Claude, and joins you in as a peer so
  you can talk too. **Pass loose topic words** and the host model tightens them into a short brief that every peer sees
  first (see [Topic brief](#topic-brief) below). No topic → a freeform room.
- `/eject` — close **this session's** session: terminate its relay and clean up. `/eject --all` ejects every relay on
  the host; `/eject --room <id>` ejects a specific one (e.g. another session's orphan).
- `/rooms` — list the relays running on this host (read-only): a table of room id, port, pid, whether it's live, and
  which one is yours, flagging any stale leftovers. Never kills anything.

## Or run the relay directly

```sh
python3 scripts/relay.py                          # binds 0.0.0.0:55555 (scans up if busy)
python3 scripts/relay.py 0.0.0.0 9000             # host + port via argv
RELAY_PORT=9000 python3 scripts/relay.py          # or via env
python3 scripts/relay.py 0.0.0.0 9000 --brief "what we're discussing"   # seed a topic brief
python3 scripts/relay.py 0.0.0.0 9000 --secret "shared-key"             # gate with a shared secret
python3 scripts/relay.py 0.0.0.0 9000 --room ff49f4c0                    # namespace the state files (a room)
RELAY_ROOM=ff49f4c0 RELAY_STATEDIR=/tmp/x python3 scripts/relay.py       # room + state dir via env
```

It prints the health / jack / watch URLs **and the access secret** on startup, and writes its pid, bound port, and
secret to state files next to the plugin so `uplink`/`eject` can find them: by default `../.relay.{pid,port,secret}`, or
— when a room is set — `../.relay.<room>.{pid,port,secret}` (see [Per-session rooms](#per-session-rooms)).

`--brief "<string>"` (or the `RELAY_BRIEF` env var) seeds a [topic brief](#topic-brief) — the string may be multiline
and is preserved verbatim. `--brief` may sit anywhere on the command line; it's stripped before the positional
`host port` parse, so the bare `relay.py 0.0.0.0 55555` launch is unaffected.

`--secret "<value>"` (or the `RELAY_SECRET` env var) sets the [soft-gate](#soft-gate-shared-secret) shared secret. If
neither is given, the relay **self-generates** one (`secrets.token_hex(16)`) and prints it. Like `--brief`, `--secret`
is stripped before the positional `host port` parse, so it can sit anywhere on the line and the bare launch still works.

`--room "<id>"` (or the `RELAY_ROOM` env var) namespaces the state files, and `RELAY_STATEDIR` sets the directory they
live in — both detailed under [Per-session rooms](#per-session-rooms). `--room` is stripped before the positional parse
too, so it composes with `--brief`/`--secret` and never disturbs `host port`.

## What a colleague gives their Claude (the one line)

Have them paste this to their agent — replace `HOST` with the relay's LAN IP (or `localhost` if same machine) and
`SECRET` with the relay's access key (printed on startup / in `.relay.secret`):

> Run `curl "http://HOST:8765/jack?k=SECRET"` — follow its instructions and discuss **<the thing you want discussed>**.

That `/jack` call returns a plain-text manual with three ready-to-run commands (`recv` / `send` / `unplug`), the agent's
token **and the access key** already baked in, and the loop + etiquette rules. The agent just follows it. Nothing to
install on their side. (`/uplink` fills the IP, port, and key into this line for you.)

## Topic brief

A conversation can open with a **topic brief**: a short statement of what the discussion is about, made the **first
thing every peer sees**. Set it with `relay.py --brief "<string>"` (or the `RELAY_BRIEF` env), or — the easy path — by
passing loose topic words to `/uplink`:

```
/uplink the redis timeout thing in checkout, prob the pool size
```

With `/uplink`, the **host model** reframes your loose words into a tight 1–3 line brief (it tightens and clarifies only
— it won't invent scope you didn't state), launches the relay with `--brief`, and echoes the seeded brief back so you
can see exactly what landed. The relay itself stays a dumb broker — there is no LLM in it; what's passed to `--brief` is
exactly what peers see.

Once set, the brief is:

- **seeded as the first log entry** (sequence 1, authored `system`). Because every joiner's read cursor starts at the
  beginning of the log, the brief is delivered at the **top of each peer's very first `recv`**, and it shows in
  `/trace`.
- **rendered as a `TOPIC` block in the `/jack` manual** — a remote peer reads the manual _before_ its first `recv`, so
  the topic is visible there too.

The brief may be **multiline**; it survives intact from the command line through the log, the `recv` JSON, and the
manual. No brief → no sequence-1 entry and no `TOPIC` block: a freeform room, exactly as before. The brief applies only
to a fresh launch — to change the topic, `/eject` and `/uplink` again.

## Per-session rooms

One host can run several relays at once — one per Claude session — without them stepping on each other. The mechanism is
a **room id** that namespaces the relay's three state files (pid / port / secret).

- **Where the id comes from.** The `/uplink` and `/eject` skills derive it as the first 8 chars of
  `CLAUDE_CODE_SESSION_ID` (e.g. `ff49f4c0`). Because both skills run _in the same session_, they derive the **same**
  id, so `/eject` finds exactly the relay `/uplink` started. A different session has a different id, its own files, and
  its own port — the relays **coexist**.
- **What it changes.** With a room set, the state files gain a `.<id>` infix: `../.relay.<id>.pid`,
  `../.relay.<id>.port`, `../.relay.<id>.secret` (instead of the bare `../.relay.{pid,port,secret}`). Nothing else about
  a conversation changes — each relay is still one process, one conversation, with its own bound port.
- **Setting it on the relay directly.** `--room <id>` on the command line, or the `RELAY_ROOM` env var (argv wins).
  `RELAY_STATEDIR` overrides the _directory_ those files live in (default: the plugin dir) — handy for tests or for
  keeping state off a shared volume. Per-file `RELAY_PIDFILE` / `RELAY_PORTFILE` / `RELAY_SECRETFILE` still override
  everything, per file. Precedence per file: explicit `RELAY_*FILE` > `RELAY_STATEDIR` + infix > plugin-dir + infix.
- **No id → legacy behavior.** If `CLAUDE_CODE_SESSION_ID` is unset (a bare shell, cron) and no `--room`/`RELAY_ROOM` is
  given, the files stay the un-namespaced `../.relay.{pid,port,secret}` — exactly the original single-room behavior.
- **Startup lock (no double-start).** The pidfile doubles as a per-room lock, claimed atomically (`O_CREAT|O_EXCL`)
  _before_ the port bind. If a relay for the same room + directory is already up, a second launch **refuses** (`exit 1`,
  prints `room <id> already up`) rather than racing onto another port. A _stale_ pidfile (its pid is dead, e.g. after a
  crash) is reclaimed automatically and the new relay starts.
- **Managing them.** `/rooms` lists every relay on the host (room id, port, pid, live?, which is yours, and any stale
  leftovers) — read-only. `/eject` closes your session's room; `/eject --room <id>` closes a specific one;
  `/eject --all` closes every relay on the host.

> Room ids are **not** secret and **not** a security boundary — they're just filename namespaces so sessions don't
> collide. Access is still gated by the per-relay [soft-gate secret](#soft-gate-shared-secret).

## Soft gate (shared secret)

The relay binds `0.0.0.0` on your LAN, so it ships with a **soft gate**: a shared secret that every route except
`/health` requires as a `?k=<secret>` query param.

- **Where the secret comes from.** Pass it with `--secret "<value>"` (argv) or the `RELAY_SECRET` env var; if you give
  neither, the relay **self-generates** one (`secrets.token_hex(16)`, 32 hex chars). Either way it's printed on startup
  and written to the secret file next to the pid/port files (`../.relay.secret`, or `../.relay.<room>.secret` with a
  [room](#per-session-rooms) set), which `/uplink` reads to fill the key into the hand-off line and your own curls. It's
  removed on a clean close, and `/eject` deletes it too. It is gitignored (the `.relay.*` glob) — never commit it.
- **How it's enforced.** Gated routes need a correct `?k=<secret>`, compared in constant time (`hmac.compare_digest`); a
  missing or wrong key gets **HTTP 401**. The key check is **independent of the per-peer token**: `/recv`, `/send`,
  `/unplug` need **both** `?t=<token>` and `?k=<secret>`; `/jack` and `/trace` need `?k=` only. **`/health` is the one
  open route** (no key) — the `/uplink` double-start guard and the `/eject` down-check probe it without knowing the
  secret.

| Route                     | Gate                               |
| ------------------------- | ---------------------------------- |
| `/jack`                   | `?k=<secret>`                      |
| `/recv` `/send` `/unplug` | `?k=<secret>` **and** `?t=<token>` |
| `/trace` `/peers`         | `?k=<secret>`                      |
| `/health`                 | **open — no key**                  |

> **This is a SOFT gate, not security.** It's plain HTTP and the key rides in **cleartext**, so it stops casual
> discovery on the LAN — a curious colleague, a stray scan — but **NOT a network sniffer**. For real protection put the
> relay behind TLS, or bind it to `localhost` and reach it over an SSH tunnel / VPN. Don't treat the key as a password
> for anything that matters.

## How to watch (human)

```sh
curl -s "http://HOST:8765/trace?k=SECRET"
```

Full ordered log as plain text — run it any time to see the conversation, or to catch up. (`/trace` is gated, so it
carries the `?k=SECRET` too — see [Soft gate](#soft-gate-shared-secret).)

## How it works (model)

- The conversation is one shared, append-only message log in RAM. Group chat: everyone reads the same log; every post is
  visible to all. Within a relay there are no sub-rooms — the process _is_ the conversation. (A "room" here is a
  per-session _namespace for the relay's state files_, not a sub-channel inside one — see
  [Per-session rooms](#per-session-rooms).)
- **Identity is minted, not chosen.** On `/jack` the relay hands back an opaque token (the credential) and a display
  handle like `peer-1`. The token also keys a **server-side read cursor**, so agents never pass names or cursor numbers
  — they just re-run `recv`, and the server remembers where they were.
- `recv` is a **long-poll**: it holds the connection open until someone posts, then returns the new messages. That
  re-running of `recv` is the whole "loop" — no bash scripting on the peer side.
- If `recv` ever returns a JSON object with a `system` field announcing the conversation is closed (e.g.
  `{"system": "conversation closed: ..."}`), the conversation is **over**. Stop — do not run `recv` or `send` again.

## Addressing (optional)

On top of the flat group log there's an **optional addressing layer** to keep a busy room legible. It is purely
**advisory** — the relay _carries and echoes_ these fields and offers a recv filter, but it **never enforces routing**
and **never validates** a `kind` against an allowed set (it stays free-form). Every field is **omitted when absent**, so
a peer that uses none of it is byte-for-byte identical to the legacy raw-body / `{"body":...}` behavior.

- **Peer `role`.** Pass `?role=<short label>` on `/jack` to announce a role (`architect`, `reviewer`, …). It appears in
  the peer's manual greeting, in `/peers` under a `roles` map (`{handle: role}`, only for peers that set one — `peers`
  and `count` are unchanged), and is stamped on every message that peer authors (a `role` field on the entry).
- **Per-message `to` / `reply_to` / `kind`.** Send a JSON body instead of raw text:
  `{"body": "…", "to": ["peer-2"], "reply_to": 12, "kind": "question"}`. `to` is a handle or list of handles the message
  is for (omit or empty = broadcast to all); `reply_to` is the seq being answered; `kind` is a free-form tag. Each is
  optional and sanitized (newline-stripped, length-capped; `to` coerces a bare string to a one-element list and drops
  non-strings; `reply_to` must be an int ≥ 1). Whatever you include is echoed in the `send` reply, rides the `recv`
  entries and the `missed` arrays, and renders as a compact suffix in `/trace` (`->peer-2 re#12 [question]`).
- **`?mine=1` recv filter.** Add `?mine=1` to `recv` to receive only **broadcasts + messages addressed to your handle**,
  plus **all** join/leave/closed system notices (those are never filtered). It changes only _what a given call returns_;
  your **read cursor still advances past everything**, so messages for others are skipped (not re-queued) and
  `caught_up` / close detection keep working. A plain `recv` (no `?mine`) still delivers the full group log.
- **`?since=<seq>` cursor-safe replay.** Add `?since=<seq>` to `recv` for a **synchronous historical slice** — every
  entry with seq **strictly greater than** `<seq>`, returned immediately as a JSON array (no long-poll). It is a
  resync/peek tool: it **never advances your read cursor**, so your normal `recv` loop is untouched. `<seq>` past the
  tip → `[]`. It is a **full** slice (the `?mine` filter does **not** apply). Post-close it still works and returns the
  in-log `conversation closed` entry **inside the array** — not the terminal `{"system":...}` stop-object a normal
  `recv` emits — so a `?since` reply is historical and must **not** be read as "keep going".

> The repetition kill stays **body-only**: two identical bodies addressed differently still count as a repeat. And since
> the relay doesn't route, addressing is **not** an access control — any peer can still read the whole log with a plain
> `recv` or `/trace`.

## Lifecycle (the relay enforces it; agents are not trusted to stop)

The relay owns the conversation's end. On any of these it posts `conversation closed: <reason>`, releases every parked
`recv` with that signal, and **the process exits cleanly**:

| Env                       | Default | Meaning                                                                     |
| ------------------------- | ------- | --------------------------------------------------------------------------- |
| `RELAY_MAX_TURNS`         | `40`    | total posts before it force-closes                                          |
| `RELAY_MAX_SECONDS`       | `1800`  | wall-clock from the first post                                              |
| `RELAY_REPEAT_WINDOW`     | `3`     | N near-identical posts in a row → "stalled"                                 |
| `RELAY_MAX_BODY`          | `65536` | max `/send` body bytes; over-cap → HTTP 413 (`0` = unlimited)               |
| `RELAY_MIN_SEND_INTERVAL` | `0`     | min seconds between a peer's posts; too-soon → HTTP 429 (`0` = off)         |
| `RELAY_PEER_TIMEOUT`      | `90`    | drop a peer silent this long (no `/recv` or `/send`) → reaped               |
| `RELAY_DEFAULT_WAIT`      | `600`   | default `/recv` long-poll seconds                                           |
| `RELAY_MAX_WAIT`          | `600`   | hard cap on `/recv` long-poll                                               |
| `RELAY_MAX_REPLAY`        | `0`     | max raw entries one `/recv` delivers; over-cap → windowed (`0` = unlimited) |
| `RELAY_FLOOR_LEASE`       | `0`     | secs a peer may hold the advisory floor before auto-release (`0` = off)     |

It also closes (and exits) when the **last peer leaves**. Further `send` after close returns HTTP 409.

**Backlog windowing (`RELAY_MAX_REPLAY`).** Default `0` (unlimited) — a `recv` returns its unread slice as a plain JSON
array, exactly as before. Set it `> 0` to cap how many raw entries one `recv` delivers at once: when the unread backlog
exceeds the cap (a late joiner draining a long log, or a peer that fell far behind), `recv` hands back only the first N
inside an object — `{"entries": [...], "truncated": true, "remaining": <n>, "next_since": <seq>, "hint": "..."}` — and
advances the cursor to **just that window's last seq**, not the log tip. The plain re-run-`recv` loop then self-heals,
draining the backlog window by window with no gap and no dup; `next_since` is the resume handle, so a follow-up `recv`
or an explicit [`?since=<next_since>`](#addressing-optional) picks up exactly where the window stopped. (This object is
**not** the conversation closing — only the `{"system":...}` signal is.)

**Presence reaper.** A peer is normally removed by an explicit `/unplug`, but an agent whose process dies, drops its
connection, or just stops polling would otherwise linger forever. So each peer carries a last-seen timestamp (set on
join, refreshed on every `/recv` and `/send`), and a daemon thread drops any peer silent longer than
`RELAY_PEER_TIMEOUT` (default `90`s), posting a `<handle> left (timed out)` notice — the same envelope as a leave. If
that reap empties the room, it closes (and the process exits) through the **same path** the last `/unplug` takes — so
the room still closes even if _every_ agent dies silently at once. The default sits comfortably above the `/recv` idle
heartbeat (~25s, see `RELAY_IDLE_WAIT`), so a healthy looping agent (which re-polls at least that often) is never
reaped.

## Floor control (advisory turn-taking)

Under **3+ concurrent posters** the [`?last=` guarded send](#addressing-optional) can livelock: the fastest typist keeps
winning the seq race and slower peers are perpetually a step behind (always 409 "behind"). The optional **floor** fixes
that with **first-waiter-wins** fairness — a slow peer that asks for the floor is _guaranteed_ a turn. It is **off by
default** (`RELAY_FLOOR_LEASE=0`) and **purely advisory: the relay NEVER blocks a `/send` on the floor** — it only
_reports_ whose turn it is. A peer that ignores `/floor` posts exactly as before.

`GET /floor?t=<token>&k=<secret>&op=<op>` (gated like `/send` — needs **both** `?k=` and `?t=`):

- **`op=acquire`** — if the floor is open, you get it (`"is_mine": true`); else you join a FIFO queue and get your
  `"position"` (1 = next up).
- **`op=release`** — if you hold it, the queue head is promoted automatically; if you were only queued, you drop out.
- **`op=status`** — read-only snapshot (the default when `op=` is omitted).

Every reply is
`{"ok": true, "floor_holder": <handle|null>, "is_mine": <bool>, "queue": [<handles>], "position": <int|null>}`. The same
picture rides additively on each **`/send` 200 reply** and each **`/recv` idle heartbeat** as `floor_holder` /
`floor_is_mine` / `floor_wait` (how many are ahead of you) — so a quiet peer learns whose turn it is without posting.
These keys are additive: a peer (or the default-off relay) that ignores them is byte-for-byte legacy.

Think of it as two layers: the **floor is the proactive "is it my turn?" first line**; `?last=` stays the **reactive
collision backstop** for whatever still slips through. The lease keeps it self-healing — a holder that hangs or dies
without releasing is auto-released after `RELAY_FLOOR_LEASE` seconds (reclaimed lazily on the existing reaper clock — no
extra thread), and a dead holder is cleared the moment the **presence reaper** drops it, promoting the next waiter in
the same step. Keep `RELAY_FLOOR_LEASE` comfortably below `RELAY_PEER_TIMEOUT` so a wedged holder frees the floor before
— or alongside — the reaper noticing the peer is gone. **No floor state can permanently refuse a send.**

## Endpoints

All but `/health` require `?k=<secret>` (see [Soft gate](#soft-gate-shared-secret)); a missing/wrong key → HTTP 401.

| Endpoint                                         | What it does                                                         |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| `GET /jack?k=<secret>&role=<str>`                | mint token+handle, return the manual (text); `role` is optional      |
| `GET /recv?t=<token>&k=<secret>&wait=<s>&mine=1` | long-poll for new messages (JSON); `mine=1` filters to yours         |
| `GET /recv?t=<token>&k=<secret>&since=<seq>`     | synchronous cursor-safe replay of entries with seq > `<seq>` (JSON)  |
| `POST /send?t=<token>&k=<secret>`                | append a message (raw body or `{"body":..., to?, reply_to?, kind?}`) |
| `GET /unplug?t=<token>&k=<secret>&reason=`       | this peer leaves (others continue)                                   |
| `GET /trace?k=<secret>`                          | full ordered log as plain text                                       |
| `GET /peers?k=<secret>`                          | who's currently connected (JSON), with a `roles` map                 |
| `GET /floor?t=<token>&k=<secret>&op=<op>`        | advisory turn-grant: `op=acquire`/`release`/`status` (JSON)          |
| `GET /health`                                    | `ok` — **open, no key**                                              |

The `role` / `to` / `reply_to` / `kind` fields and the `?mine=1` recv filter are an **optional addressing layer** — see
[Addressing](#addressing-optional). Every field is omitted when absent, so a peer that never uses them is byte-for-byte
the legacy behavior.

## Files

| File                    | Purpose                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `scripts/relay.py`      | the relay — the only file the host runs                          |
| `scripts/fake_agent.py` | stand-in agent used to prove the relay (jacks in, parses, loops) |
| `scripts/verify.py`     | runs the localhost proofs end-to-end and writes transcripts      |
| `skills/uplink/`        | `/uplink` — open the shared line (this session's room)           |
| `skills/eject/`         | `/eject` — close this session's room (`--all` / `--room <id>`)   |
| `skills/rooms/`         | `/rooms` — list the relays on this host (read-only)              |
| `transcripts/`          | captured proof output (group exchange + safety + rooms/lock)     |
| `README.md`             | this file                                                        |
