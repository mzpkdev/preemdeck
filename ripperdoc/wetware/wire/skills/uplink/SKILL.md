---
description: |
  Open the live multi-agent comms session — raise the shared line (uplink).
  Launches the wire relay DETACHED on this host (0.0.0.0, auto-selecting a free
  port), prints the one curl line to hand a colleague's Claude so they join over
  the LAN, and prints the host's own optional jack line so you can talk too if
  you want (the host watches via /trace by default, no auto-jack).
  User-invoked via /uplink. One process == one conversation; close it with
  /eject.
user-invocable: true
argument-hint: '[loose topic words — what the discussion is about]'
allowed-tools: [Bash]
---

# Uplink

Open the shared line: boot the wire relay and hand out the line; the host can optionally jack in to talk, but by default
it just watches via `/trace`. One relay process is one conversation, and that host:port is its identity. **This session
gets its own room.** The room id is derived from the Claude session (`CLAUDE_CODE_SESSION_ID`, first 8 chars) and
namespaces the relay's state files, so several Claude sessions on THIS host can each run their own relay side by side —
they coexist on distinct ports and never clobber each other's files. `/eject` in the same session derives the same id,
so it kills exactly this session's relay. (No session id in the env — a bare shell or cron — falls back to the legacy
single-room files, exactly as before.) The relay auto-selects a free port (base `55555`, scanning upward if busy) and
writes the port it actually bound to `wire/.relay${RID}.port`.

If the operator passed an argument, it is the **loose topic** for this discussion. Tighten it into a short **brief**
(see step 0) and launch the relay with `--brief`, so that brief becomes the FIRST thing every peer LLM sees — it is
seeded as the seq-1 system message (top of every joiner's first `recv`) and rendered as a `TOPIC` block in the `/jack`
manual. No argument → no `--brief` → a freeform room, exactly as before.

## How to run

0. **Compose the brief from the operator's argument (this is YOUR turn, not the relay's).** The relay is a dumb broker
   with no LLM — the wording→brief step happens HERE, in your head, before you launch.

   - **No argument given** → there is no brief. Skip straight to step 1 and launch WITHOUT `--brief` (freeform room,
     exactly as before). Do not invent a topic.
   - **Argument given** → it is loose topic words. **REFRAME** them into a tight **1–3 line brief** stating what the
     discussion is about. Tighten and clarify only — do **NOT** invent scope, goals, constraints, or deliverables the
     operator did not state. If the input is already a clean sentence, keep it almost verbatim. Keep it short; the brief
     leads every peer's view.

   Example — operator types `/uplink the redis timeout thing in checkout, prob the pool size`; a good brief is:
   `Investigating intermittent Redis timeouts in the checkout path. Leading hypothesis: connection-pool sizing.` (Two
   lines max, no invented fix or scope.)

   Hold that brief in a shell variable so you can pass it verbatim and echo it back. It may be multiline; keep it as ONE
   argument (one `--brief` token):

   ```bash
   BRIEF=$'Investigating intermittent Redis timeouts in the checkout path.\nLeading hypothesis: connection-pool sizing.'
   ```

1. **Derive this session's room, refuse to double-start (per session), then launch the relay DETACHED.** It must NOT
   block this session. The room id is the first 8 chars of `CLAUDE_CODE_SESSION_ID`; it infixes every state file
   (`wire/.relay.<room>.{port,pid,secret,log}`). If the env var is unset (bare shell / cron) the infix is empty and you
   get the legacy `wire/.relay.{port,pid,secret,log}` — single-room fallback.

   The double-start guard is now **per session**: it only refuses if THIS session's room is already up. A different
   session has a different room id (different files) and coexists fine. (The brief only applies to a FRESH launch; if
   this session's relay is already up, you do not get to re-seed it — `/eject` first to start a new conversation.)

   Build the relay's argv with a bash **array** so the optional `--room` and the optional multiline `--brief` both
   compose cleanly — one launch line, no near-duplicate blocks:

   ```bash
   PLUGIN="${CLAUDE_PLUGIN_ROOT}"
   ROOM="${CLAUDE_CODE_SESSION_ID:0:8}"   # this session's room id ("" if env unset)
   RID="${ROOM:+.$ROOM}"                  # filename infix: ".<room>" or "" (legacy)
   PORTFILE="$PLUGIN/.relay${RID}.port"
   # Refuse to double-start THIS session's room: if its portfile exists and that port is healthy, it's already up.
   if [ -f "$PORTFILE" ]; then
     EXIST_PORT="$(cat "$PORTFILE" 2>/dev/null)"
     if [ -n "$EXIST_PORT" ] && curl -s --max-time 1 "http://127.0.0.1:${EXIST_PORT}/health" | grep -q ok; then
       echo "this session already has a room up on :${EXIST_PORT} — /eject first, or use it."; exit 0
     fi
   fi
   # Compose argv: host+port always; --room only if we have one; --brief only if set (newlines preserved as one token).
   ARGS=(0.0.0.0 55555)
   [ -n "$ROOM" ]  && ARGS+=(--room "$ROOM")
   [ -n "$BRIEF" ] && ARGS+=(--brief "$BRIEF")
   # RELAY_FLOOR_LEASE: advisory floor turn-taking, 30s — below the 90s peer timeout so a wedged holder self-frees.
   RELAY_FLOOR_LEASE=30 nohup python3 "$PLUGIN/scripts/relay.py" "${ARGS[@]}" \
     > "$PLUGIN/.relay${RID}.log" 2>&1 < /dev/null &
   disown 2>/dev/null || true
   ```

   The relay binds `0.0.0.0:<free-port>` (base `55555`, scanning up if taken) and writes its pid to
   `$PLUGIN/.relay${RID}.pid` and the bound port to `$PLUGIN/.relay${RID}.port`. The pidfile is also a per-room startup
   lock: if a relay for this room is somehow already up, the new one refuses to start (so the conversation can't fork
   onto a second port). When a brief is passed it is seeded as the seq-1 system message and shown in the `/jack`
   manual's `TOPIC` block, so every peer sees it first. (If `$BRIEF` is empty/unset the array simply omits `--brief` — a
   freeform room.)

2. **Wait for the portfile to appear, health-check that port, then read the access secret** (short, bounded — never
   block). The relay self-generates a shared **soft-gate secret** and writes it to `wire/.relay${RID}.secret` (next to
   this room's portfile); read it the same way you read the port. Every route except `/health` requires `?k=<SECRET>`,
   so you need this value for the hand-off line and the host's own curls below.

   ```bash
   PLUGIN="${CLAUDE_PLUGIN_ROOT}"
   RID="${CLAUDE_CODE_SESSION_ID:0:8}"; RID="${RID:+.$RID}"   # same infix as the launch
   PORTFILE="$PLUGIN/.relay${RID}.port"
   SECRETFILE="$PLUGIN/.relay${RID}.secret"
   PORT=""
   for i in $(seq 1 30); do
     [ -f "$PORTFILE" ] && PORT="$(cat "$PORTFILE" 2>/dev/null)" && [ -n "$PORT" ] && break
     sleep 0.2
   done
   if [ -z "$PORT" ]; then
     echo "relay did not write a portfile — startup failed:"; tail -n 20 "$PLUGIN/.relay${RID}.log"; exit 1
   fi
   for i in $(seq 1 20); do
     curl -s --max-time 1 "http://127.0.0.1:${PORT}/health" | grep -q ok && { echo "up on :${PORT}"; break; }
     sleep 0.2
   done
   # Read the soft-gate secret the same bounded way (it's written right after the portfile).
   SECRET=""
   for i in $(seq 1 30); do
     [ -f "$SECRETFILE" ] && SECRET="$(cat "$SECRETFILE" 2>/dev/null)" && [ -n "$SECRET" ] && break
     sleep 0.2
   done
   ```

   If it never reports `up`, print the tail of `$PLUGIN/.relay${RID}.log` and stop. Use `$PORT` (the bound port) and
   `$SECRET` (the access key) for everything below — do NOT assume any fixed port, and do NOT hardcode a key.

3. **Detect this host's LAN IP** (try the common macOS/Linux paths, fall back):

   ```bash
   LAN_IP="$(ipconfig getifaddr en0 2>/dev/null \
     || ipconfig getifaddr en1 2>/dev/null \
     || hostname -I 2>/dev/null | awk '{print $1}' \
     || hostname -i 2>/dev/null)"
   echo "${LAN_IP:-<this-host-LAN-IP>}"
   ```

4. **Print the exact line to hand a colleague.** Substitute the detected IP, the bound `$PORT`, and the `$SECRET`. The
   `?k=<SECRET>` is required — `/jack` is gated — so it MUST be in the hand-off line, or their first call gets a 401:

   ```
   Give your colleague's Claude this:

     Run  curl "http://<LAN_IP>:<PORT>/jack?k=<SECRET>"  — follow its instructions and discuss <your topic>.
   ```

   If on the same machine they can use `localhost` instead of `<LAN_IP>`. When a brief was set, the colleague's peer
   will see it first anyway (seq-1 message + manual `TOPIC` block), so you can keep `<your topic>` short here. The key
   is a **soft gate**: it keeps strangers off the line, but it rides in cleartext over plain HTTP — it is NOT
   sniffer-proof.

5. **Print the host's own jack line — OPTIONAL, not automatic.** By default the host (you) just boots the relay and
   watches the room from the outside via `/trace`; it does NOT jack in. Auto-jacking would plant a silent "ghost" peer
   that shows up in presence and holds the room open after everyone else has left. So do not run this on every uplink —
   only jack in when you actually want to talk. Print the line so the user can fire it on demand (against the bound
   `$PORT`, with the key):

   ```bash
   echo "If you want to talk too, jack in:  curl -s --max-time 5 \"http://127.0.0.1:${PORT}/jack?k=${SECRET}\""
   ```

   Running that jack returns the plain-text manual with YOUR token AND the access key already filled into the `recv` /
   `send` / `unplug` curls (the manual templates the real bound port and key automatically). Use those to participate:
   `recv` to listen, `send` to post, `unplug` (or `/eject`) when done. Until you jack, you stay a non-peer and the room
   closes naturally once the last real peer leaves.

## What to return

- One line confirming the relay is up (host:port with the real bound port + pid if known).
- **If a brief was set, echo it back** — show the operator the exact brief that landed (the verbatim text you passed to
  `--brief`, the same thing every peer now sees as seq-1 and in the manual `TOPIC` block), so they can confirm the
  reframing is right. If no argument was given, say it's a freeform room (no topic seeded).
- The colleague hand-off line with the real LAN IP, bound port, **and `?k=<SECRET>`** filled in (the gate is required).
- The host's own **optional** jack line (`/jack?k=<SECRET>` against the bound port) — note that the host watches via
  `/trace` by default and only needs to jack if it wants to talk. Do NOT auto-jack the host. (If the user does jack, the
  manual hands back the `recv` / `send` / `unplug` curls with token **and key** baked in.)
- A one-line note that the key is a soft gate — keeps strangers out, not sniffers (plain HTTP).

## Critical

- The relay MUST be detached — this session cannot block on it. Background + log + `< /dev/null`.
- **This session has its own room.** Derive `ROOM="${CLAUDE_CODE_SESSION_ID:0:8}"` and the infix `RID="${ROOM:+.$ROOM}"`
  ONCE per bash block (each block is a fresh shell) and reuse it for every state file (`wire/.relay${RID}.port`, `.pid`,
  `.secret`, `.log`). Unset session id (bare shell/cron) → empty infix → the legacy `wire/.relay.*` files. Pass
  `--room "$ROOM"` on the launch only when `$ROOM` is non-empty.
- The bound port is whatever the relay wrote to `wire/.relay${RID}.port` — never hardcode a port. Read it from this
  room's portfile.
- The access key is whatever the relay wrote to `wire/.relay${RID}.secret` — never hardcode or invent a key. Read it
  from this room's secretfile, and put `?k=<SECRET>` on every URL except `/health`. It is a **soft gate** (cleartext,
  plain HTTP): it keeps strangers off the LAN line, not a sniffer. `/health` stays open so the double-start guard above
  can probe it.
- One relay == one conversation, one room per session. A different Claude session on this host runs its OWN relay on its
  OWN port (distinct room id) — they coexist. To start fresh in THIS session, `/eject` then `/uplink` again.
- The brief only applies to a FRESH launch. If a relay is already up, this skill refuses (step 1) — it does NOT re-seed
  a running conversation. `/eject` first to change the topic.
- Reframe, never invent. The brief restates the operator's words tightly; it must not add scope, goals, or constraints
  they didn't state. The relay never paraphrases — what you pass to `--brief` is exactly what peers see.
- Advisory floor turn-taking is ON by default (`RELAY_FLOOR_LEASE=30` on the launch) so peers take fair turns under
  load. For very short turns it costs a round-trip, but it stops the fastest typist from starving slower peers once 3+
  posters are concurrent.
- The conversation auto-closes (and the process exits) on the turn cap, wall-clock cap, repetition kill, or when the
  last peer leaves.
