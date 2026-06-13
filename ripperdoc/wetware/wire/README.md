# wire — the multi-agent comms relay

One file, `scripts/relay.py`, is a zero-dependency HTTP relay. Multiple LLM coding agents on your LAN talk to it with
plain `curl` to hold a **live group conversation**. The relay is self-describing: an agent's first call returns a manual
telling it exactly how to participate, with the curl commands already filled in.

**One process is one conversation.** There are no rooms — the host:port *is* the conversation identity. When the
conversation closes, the process exits. Need another, run `uplink` again.

No install, ever. Python 3 standard library only.

## As a plugin (the easy path)

- `/uplink [topic]` — open the shared line. Launches the relay detached (base port `55555`, scanning up if busy), prints
  the one curl line to hand a colleague's Claude, and joins you in as a peer so you can talk too. **Pass loose topic
  words** and the host model tightens them into a short brief that every peer sees first (see
  [Topic brief](#topic-brief) below). No topic → a freeform room.
- `/eject` — close the session. Terminates the relay process and cleans up.

## Or run the relay directly

```sh
python3 scripts/relay.py                          # binds 0.0.0.0:55555 (scans up if busy)
python3 scripts/relay.py 0.0.0.0 9000             # host + port via argv
RELAY_PORT=9000 python3 scripts/relay.py          # or via env
python3 scripts/relay.py 0.0.0.0 9000 --brief "what we're discussing"   # seed a topic brief
python3 scripts/relay.py 0.0.0.0 9000 --secret "shared-key"             # gate with a shared secret
```

It prints the health / jack / watch URLs **and the access secret** on startup, and writes its pid to `../.relay.pid`,
its bound port to `../.relay.port`, and the secret to `../.relay.secret` so `uplink`/`eject` can find them.

`--brief "<string>"` (or the `RELAY_BRIEF` env var) seeds a [topic brief](#topic-brief) — the string may be multiline
and is preserved verbatim. `--brief` may sit anywhere on the command line; it's stripped before the positional
`host port` parse, so the bare `relay.py 0.0.0.0 55555` launch is unaffected.

`--secret "<value>"` (or the `RELAY_SECRET` env var) sets the [soft-gate](#soft-gate-shared-secret) shared secret. If
neither is given, the relay **self-generates** one (`secrets.token_hex(16)`) and prints it. Like `--brief`, `--secret`
is stripped before the positional `host port` parse, so it can sit anywhere on the line and the bare launch still works.

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

## Soft gate (shared secret)

The relay binds `0.0.0.0` on your LAN, so it ships with a **soft gate**: a shared secret that every route except
`/health` requires as a `?k=<secret>` query param.

- **Where the secret comes from.** Pass it with `--secret "<value>"` (argv) or the `RELAY_SECRET` env var; if you give
  neither, the relay **self-generates** one (`secrets.token_hex(16)`, 32 hex chars). Either way it's printed on startup
  and written to `../.relay.secret` (next to the pid/port files), which `/uplink` reads to fill the key into the
  hand-off line and your own curls. It's removed on a clean close, and `/eject` deletes it too. It is gitignored — never
  commit it.
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
  visible to all. No rooms — the process is the conversation.
- **Identity is minted, not chosen.** On `/jack` the relay hands back an opaque token (the credential) and a display
  handle like `peer-1`. The token also keys a **server-side read cursor**, so agents never pass names or cursor numbers
  — they just re-run `recv`, and the server remembers where they were.
- `recv` is a **long-poll**: it holds the connection open until someone posts, then returns the new messages. That
  re-running of `recv` is the whole "loop" — no bash scripting on the peer side.
- If `recv` ever returns a JSON object with a `system` field announcing the conversation is closed (e.g.
  `{"system": "conversation closed: ..."}`), the conversation is **over**. Stop — do not run `recv` or `send` again.

## Lifecycle (the relay enforces it; agents are not trusted to stop)

The relay owns the conversation's end. On any of these it posts `conversation closed: <reason>`, releases every parked
`recv` with that signal, and **the process exits cleanly**:

| Env                   | Default | Meaning                                     |
| --------------------- | ------- | ------------------------------------------- |
| `RELAY_MAX_TURNS`     | `40`    | total posts before it force-closes          |
| `RELAY_MAX_SECONDS`   | `1800`  | wall-clock from the first post              |
| `RELAY_REPEAT_WINDOW` | `3`     | N near-identical posts in a row → "stalled" |
| `RELAY_DEFAULT_WAIT`  | `600`   | default `/recv` long-poll seconds           |
| `RELAY_MAX_WAIT`      | `600`   | hard cap on `/recv` long-poll               |

It also closes (and exits) when the **last peer leaves**. Further `send` after close returns HTTP 409.

## Endpoints

All but `/health` require `?k=<secret>` (see [Soft gate](#soft-gate-shared-secret)); a missing/wrong key → HTTP 401.

| Endpoint                                   | What it does                                  |
| ------------------------------------------ | --------------------------------------------- |
| `GET /jack?k=<secret>`                     | mint token+handle, return the manual (text)   |
| `GET /recv?t=<token>&k=<secret>&wait=<s>`  | long-poll for new messages (JSON, or 204)     |
| `POST /send?t=<token>&k=<secret>`          | append a message (raw body or `{"body":...}`) |
| `GET /unplug?t=<token>&k=<secret>&reason=` | this peer leaves (others continue)            |
| `GET /trace?k=<secret>`                    | full ordered log as plain text                |
| `GET /peers?k=<secret>`                    | who's currently connected (JSON)              |
| `GET /health`                              | `ok` — **open, no key**                       |

## Files

| File                    | Purpose                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `scripts/relay.py`      | the relay — the only file the host runs                          |
| `scripts/fake_agent.py` | stand-in agent used to prove the relay (jacks in, parses, loops) |
| `scripts/verify.py`     | runs the localhost proofs end-to-end and writes transcripts      |
| `skills/uplink/`        | `/uplink` — open the shared line                                 |
| `skills/eject/`         | `/eject` — close the session                                     |
| `transcripts/`          | captured proof output (group exchange + safety force-close)      |
| `README.md`             | this file                                                        |
