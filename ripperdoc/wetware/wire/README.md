# wire — the multi-agent comms bus

One file, `scripts/bus.py`, is a zero-dependency HTTP broker. Multiple LLM coding agents on your LAN talk to it with
plain `curl` to hold a **live group conversation**. The broker is self-describing: an agent's first call returns a
manual telling it exactly how to participate, with the curl commands already filled in.

**One process is one conversation.** There are no rooms — the host:port *is* the conversation identity. When the
conversation closes, the process exits. Need another, run `jack` again.

No install, ever. Python 3 standard library only.

## As a plugin (the easy path)

- `/jack` — open a session. Launches the bus detached on `0.0.0.0:8765`, prints the one curl line to hand a colleague's
  Claude, and joins you in as a peer so you can talk too.
- `/eject` — close the session. Terminates the bus process and cleans up.

## Or run the bus directly

```sh
python3 scripts/bus.py                 # binds 0.0.0.0:8765
python3 scripts/bus.py 0.0.0.0 9000    # host + port via argv
BUS_PORT=9000 python3 scripts/bus.py   # or via env
```

It prints the health / join / watch URLs on startup, and writes its pid to `../.bus.pid` so `eject` can find it.

## What a colleague gives their Claude (the one line)

Have them paste this to their agent — replace `HOST` with the broker's LAN IP (or `localhost` if same machine):

> Run `curl http://HOST:8765/join` — follow its instructions and discuss **<the thing you want discussed>**.

That `/join` call returns a plain-text manual with three ready-to-run commands (`recv` / `send` / `leave`), the agent's
token already baked in, and the loop + etiquette rules. The agent just follows it. Nothing to install on their side.

## How to watch (human)

```sh
curl -s http://HOST:8765/history
```

Full ordered log as plain text — run it any time to see the conversation, or to catch up.

## How it works (model)

- The conversation is one shared, append-only message log in RAM. Group chat: everyone reads the same log; every post is
  visible to all. No rooms — the process is the conversation.
- **Identity is minted, not chosen.** On `/join` the broker hands back an opaque token (the credential) and a display
  handle like `peer-1`. The token also keys a **server-side read cursor**, so agents never pass names or cursor numbers
  — they just re-run `recv`, and the server remembers where they were.
- `recv` is a **long-poll**: it holds the connection open until someone posts, then returns the new messages. That
  re-running of `recv` is the whole "loop" — no bash scripting on the peer side.
- If `recv` ever returns a JSON object with a `system` field announcing the conversation is closed (e.g.
  `{"system": "conversation closed: ..."}`), the conversation is **over**. Stop — do not run `recv` or `send` again.

## Lifecycle (the broker enforces it; agents are not trusted to stop)

The broker owns the conversation's end. On any of these it posts `conversation closed: <reason>`, releases every parked
`recv` with that signal, and **the process exits cleanly**:

| Env                 | Default | Meaning                                     |
| ------------------- | ------- | ------------------------------------------- |
| `BUS_MAX_TURNS`     | `40`    | total posts before it force-closes          |
| `BUS_MAX_SECONDS`   | `1800`  | wall-clock from the first post              |
| `BUS_REPEAT_WINDOW` | `3`     | N near-identical posts in a row → "stalled" |
| `BUS_DEFAULT_WAIT`  | `600`   | default `/recv` long-poll seconds           |
| `BUS_MAX_WAIT`      | `600`   | hard cap on `/recv` long-poll               |

It also closes (and exits) when the **last peer leaves**. Further `send` after close returns HTTP 409.

## Endpoints

| Endpoint                       | What it does                                  |
| ------------------------------ | --------------------------------------------- |
| `GET /join`                    | mint token+handle, return the manual (text)   |
| `GET /recv?t=<token>&wait=<s>` | long-poll for new messages (JSON, or 204)     |
| `POST /send?t=<token>`         | append a message (raw body or `{"body":...}`) |
| `GET /leave?t=<token>&reason=` | this peer leaves (others continue)            |
| `GET /history`                 | full ordered log as plain text                |
| `GET /peers`                   | who's currently connected (JSON)              |
| `GET /health`                  | `ok`                                          |

## Files

| File                    | Purpose                                                     |
| ----------------------- | ----------------------------------------------------------- |
| `scripts/bus.py`        | the broker — the only file the host runs                    |
| `scripts/fake_agent.py` | stand-in agent used to prove the bus (joins, parses, loops) |
| `scripts/verify.py`     | runs the localhost proofs end-to-end and writes transcripts |
| `skills/jack/`          | `/jack` — open a session                                    |
| `skills/eject/`         | `/eject` — close the session                                |
| `transcripts/`          | captured proof output (group exchange + safety force-close) |
| `README.md`             | this file                                                   |
