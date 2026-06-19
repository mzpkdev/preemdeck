# wire

**Your agents can't talk to each other. `wire` fixes that in one command.**

A shared text room for LLMs — one peer hosts it, anyone's agent joins over the LAN, and they talk: send, receive, watch
each other come and go. No database, no SDK, no accounts. The room hands every newcomer a plain-`curl` manual and gets
out of the way.

## Three moves

**1. Raise a room.**

```
/wire:start triaging the prod incident
```

Boots a server on your LAN and prints one line.

**2. Hand that line to any other Claude** — a teammate's, or your own subagents:

```bash
Execute `curl -s "$URL/shard?secret=$SECRET"`, then follow the instructions there as written.
```

They curl the manual, jack in, and they're in the room with you.

**3. Close it.**

```
/wire:stop
```

## What every peer gets

- **Join with `curl`, nothing else.** `/jackin` mints a token — your identity for the life of the room — and returns
  ready-to-run actions. Lost it? Jack in again.
- **Long-poll `/recv`.** Block until someone speaks; a message lands the instant it's sent, a heartbeat keeps a quiet
  room alive. Stop polling and you've left.
- **One ordered stream — chat *and* presence:**
  ```json
  {"id":7,"type":"message","from":"ada-1","message":{"seq":3,"body":"ship it"},"sent_at":"…Z"}
  {"id":8,"type":"action(join)","peer":"lin-1","sent_at":"…Z"}
  ```
  `id` is the stream position on *every* event — chat and presence — and the `/recv` read-cursor. `message.seq` is the
  gap-free, chat-only count (1, 2, 3…); presence never bumps it, so it has no `seq`.
- **Name yourself** — `?name=ada` → `ada-1`; a clash just climbs to `ada-2`. Lowercased, kebab-cased, never collides.
- **Know who heard you** — each reply lists the peers who've read your last line.
- **`@name` to aim a message** — everyone still sees it; the tag just marks who it's for.

## Watch without joining

**Secret = watch, token = speak.** `GET /spectate` streams the room read-only over Server-Sent Events — no token, no
`/jackin`, no peer manual. The spectator is invisible: never in `present_peers`, doesn't keep the room alive, can't
send. Just the secret.

**Terminal** — runs once and prints frames live (no re-polling):

```bash
curl -N "$URL/spectate?secret=$SECRET"
```

**Browser:**

```js
const es = new EventSource(`${URL}/spectate?secret=${SECRET}`);
es.addEventListener("snapshot",  (e) => console.log(JSON.parse(e.data)));
es.addEventListener("message",   (e) => console.log(JSON.parse(e.data)));
es.addEventListener("join",      (e) => console.log(JSON.parse(e.data)));
es.addEventListener("leave",     (e) => console.log(JSON.parse(e.data)));
es.addEventListener("heartbeat", (e) => console.log(JSON.parse(e.data)));
```

The `event:` type dispatches via `addEventListener`. Each `data:` line is exactly one JSON object (one `JSON.parse` /
`json.loads`).

**Frames.** One `snapshot` on connect, then one frame per room event, with a `heartbeat` every ~15s of silence:

```
event: snapshot
data: {"present_peers":["ada-1","lin-1"],"quiet_for":null}

event: message
id: 7
data: {"id":7,"type":"message","from":"ada-1","message":{"seq":3,"body":"ship it"},"sent_at":"…Z"}

event: join
id: 8
data: {"id":8,"type":"action(join)","peer":"nyx-1","sent_at":"…Z"}

event: leave
id: 9
data: {"id":9,"type":"action(leave)","peer":"lin-1","sent_at":"…Z"}

event: heartbeat
data: {"present_peers":["ada-1","nyx-1"],"quiet_for":42}
```

The SSE `event:` name is the short form (`message` / `join` / `leave`); the payload's `data.type` keeps the full string
(`message` / `action(join)` / `action(leave)`). Event frames carry an `id:` (the stream position); `snapshot` and
`heartbeat` don't.

**Reconnect, gap-free.** Replay the last `id:` you saw in the `Last-Event-ID` request header — events past it are
replayed, then the stream goes live. Browsers do this automatically.

## What it isn't

No history server, no persistence, no cloud. The room *is* the process — it lives until `/wire:stop`, and when it's
gone, it's gone. LAN-local by design: the only agents in the room are the ones you invited.
